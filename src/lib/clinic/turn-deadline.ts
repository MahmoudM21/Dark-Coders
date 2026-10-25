/**
 * One clinic turn must end, even when the provider never does.
 *
 * A measured turn took 147.9 s and another was still working when the harness gave up at
 * 180 s: the caller heard nothing and could not tell a slow answer from a broken one. The
 * bridge therefore owns a deadline — it aborts the upstream fetch itself (which closes the
 * connection rather than leaving it running), says so in the caller's language, and records
 * `turn_deadline` with the elapsed ms.
 *
 * The default is 60 s because a cold first turn on this machine measured 51.7 s: a lower
 * deadline would abort healthy turns.
 */

export const DEFAULT_TURN_DEADLINE_MS = 60_000;

/** `CLINIC_TURN_DEADLINE_MS`, or the default when unset, empty, non-numeric or not positive. */
export function turnDeadlineMs(raw: string | null | undefined = process.env["CLINIC_TURN_DEADLINE_MS"]): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TURN_DEADLINE_MS;
}

export type DeadlineLang = "ar" | "en";

/** Exactly what the caller hears when the turn ran out of time. */
export function deadlineScreen(lang: DeadlineLang, seconds: number): string {
  return lang === "ar"
    ? `الرد أخد وقت أطول من المسموح (${seconds} ثانية). جرّب تاني.`
    : `That took longer than allowed (${seconds} s). Please try again.`;
}

/** The failed-step line the console shows for this turn. The code is the searchable part. */
export function deadlineStep(ms: number): string {
  return `Failed step: TURN_DEADLINE — no answer within ${ms} ms`;
}

export type DeadlineResult<T> = { timedOut: false; value: T } | { timedOut: true; elapsedMs: number };

export type TurnDeadline = {
  /** Hand this to `fetch`: aborting it closes the upstream connection. */
  signal: AbortSignal;
  /** Milliseconds from creation to the abort, or null while the turn is still on time. */
  elapsedMs: () => number | null;
  /** Resolves "timeout" the moment the deadline fires. */
  fired: Promise<"timeout">;
  clear: () => void;
};

/**
 * The bridge's deadline: one controller per turn, aborted once. This is the exact object the
 * clinic path passes to the gateway request, and what {@link runWithDeadline} is built on, so
 * a test that drives it drives the production mechanism.
 */
export function startTurnDeadline(ms: number): TurnDeadline {
  const controller = new AbortController();
  const started = Date.now();
  let elapsedMs: number | null = null;
  let fire: () => void = () => {};
  const fired = new Promise<"timeout">((resolve) => {
    fire = () => resolve("timeout");
  });
  const timer = setTimeout(() => {
    elapsedMs = Date.now() - started;
    controller.abort();
    fire();
  }, ms);
  return { signal: controller.signal, elapsedMs: () => elapsedMs, fired, clear: () => clearTimeout(timer) };
}

/**
 * Runs `run` with an {@link AbortSignal} that fires after `ms`. The signal is handed to the
 * work rather than inferred from it, so the caller can pass it straight to `fetch` and the
 * upstream connection is closed when the deadline is reached.
 *
 * The work's own rejection is always handled, so an abort can never surface as an unhandled
 * rejection after this function has already returned the timed-out result.
 */
export async function runWithDeadline<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<DeadlineResult<T>> {
  const deadline = startTurnDeadline(ms);
  const work = run(deadline.signal).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

  try {
    const settled = await Promise.race([work, deadline.fired]);
    if (settled === "timeout") return { timedOut: true, elapsedMs: deadline.elapsedMs() ?? ms };
    if ("error" in settled) throw settled.error;
    return { timedOut: false, value: settled.value };
  } finally {
    deadline.clear();
  }
}
