/**
 * Rate-limit handling for the clinic bridge's model call.
 *
 * The agent runs on a free NVIDIA endpoint (with a Gemini failover), so a 429 is a
 * normal event rather than an outage. A 429 is worth exactly ONE automatic retry,
 * and only when the upstream said how long to wait and that wait is short — the
 * bridge never sleeps for seconds on a voice turn. When it stays busy the bridge
 * says so in the caller's language instead of inventing an answer, and every 429
 * that reached the bridge is written to `audit_events` by the caller.
 *
 * Everything here is pure apart from the injected `sleep`, so the decision table is
 * unit-tested against fake upstream responses.
 */

/** Longest wait the bridge will accept before deciding not to retry at all. */
export const MAX_RETRY_AFTER_MS = 2000;

/** Phrases a provider uses when it is throttling us rather than failing. */
const RATE_LIMIT_PATTERNS = [
  /rate[ _-]?limit/i,
  /too many requests/i,
  /throttl/i,
  /quota exceeded/i,
];

export type RetryAfterInput = string | null | undefined;

/**
 * Turns a `Retry-After` header into a delay in milliseconds, or null when the value
 * is missing or unparseable. Both documented forms are accepted (seconds, or an
 * HTTP date); a date already in the past means "now".
 */
export function retryAfterDelayMs(value: RetryAfterInput, nowMs: number): number | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  // The other documented form is an HTTP date, and all three formats of it start with
  // a weekday name. Requiring that keeps junk ("1.5", "soon") from being parsed as a
  // date and silently turned into "retry immediately".
  if (!/^(mon|tue|wed|thu|fri|sat|sun)/i.test(raw)) return null;
  const asDate = Date.parse(raw);
  if (Number.isNaN(asDate)) return null;
  return Math.max(0, asDate - nowMs);
}

export type UpstreamFailure = {
  /** True for HTTP 429 and for any status whose body says the provider is throttling. */
  rateLimited: boolean;
  /** How long to wait before the single retry, or null when there must not be one. */
  retryDelayMs: number | null;
};

/**
 * Classifies a failed model response. Only a rate limit is retried: any other
 * failure must surface as the real error (the caller turns it into the safe screen).
 */
export function classifyUpstreamFailure(input: {
  status: number;
  body: string;
  retryAfter: RetryAfterInput;
  nowMs: number;
}): UpstreamFailure {
  const rateLimited =
    input.status === 429 || RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(input.body));
  if (!rateLimited) return { rateLimited: false, retryDelayMs: null };

  const retryDelayMs = retryAfterDelayMs(input.retryAfter, input.nowMs);
  // Present and short enough to wait for; otherwise no retry at all (never a guess).
  if (retryDelayMs === null || retryDelayMs > MAX_RETRY_AFTER_MS)
    return { rateLimited: true, retryDelayMs: null };
  return { rateLimited: true, retryDelayMs };
}

export type RateLimitedEvent = { attempt: number; status: number; retryDelayMs: number | null };

/**
 * Calls the model, retrying once when the upstream rate-limits us and asked us to
 * wait no longer than MAX_RETRY_AFTER_MS. Returns the successful `Response`, or null
 * when the upstream is still rate-limiting after the retry (or when it gave no wait
 * worth honouring) — the caller then speaks the busy screen. A non-rate-limit
 * failure throws `MODEL_HTTP_<status>:<body>` exactly as before.
 */
export async function callModelWithRateLimitRetry(input: {
  call: () => Promise<Response>;
  /** Called for every 429 (or throttling body) the bridge actually saw. */
  onRateLimited: (event: RateLimitedEvent) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<Response | null> {
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;
  let attempt = 1;
  let response = await input.call();

  while (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    const verdict = classifyUpstreamFailure({
      status: response.status,
      body,
      retryAfter: response.headers.get("retry-after"),
      nowMs: now(),
    });
    if (!verdict.rateLimited) throw new Error(`MODEL_HTTP_${response.status}:${body}`);

    await input.onRateLimited({
      attempt,
      status: response.status,
      retryDelayMs: verdict.retryDelayMs,
    });
    if (attempt > 1 || verdict.retryDelayMs === null) return null;

    await sleep(verdict.retryDelayMs);
    attempt += 1;
    response = await input.call();
  }

  return response;
}

/**
 * What the caller hears when the provider is still busy. It is a normal screen with
 * the only recovery the panel offers, it states no result, and it is built fresh
 * per locale rather than cached from any previous reply.
 */
export function busyScreen(locale: string) {
  const arabic = locale.toLowerCase().startsWith("ar");
  return {
    kind: "screen" as const,
    screen: {
      text: arabic
        ? "الخدمة مشغولة دلوقتي، جرّب بعد ثواني."
        : "The service is busy right now. Please try again in a few seconds.",
      choices: [],
      navigation: ["home"] as const,
    },
    action_proposal: null,
    app_commands: [],
  };
}
