import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RETRY_AFTER_MS,
  busyScreen,
  callModelWithRateLimitRetry,
  classifyUpstreamFailure,
  retryAfterDelayMs,
  type RateLimitedEvent,
} from "./upstream.server.ts";

const NOW = Date.parse("2026-10-16T20:00:00Z");

function fail(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

function ok(text = "hello") {
  return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** Records what the bridge would audit and how long it slept. */
function harness(responses: Response[]) {
  const queue = [...responses];
  const events: RateLimitedEvent[] = [];
  const sleeps: number[] = [];
  let calls = 0;
  return {
    events,
    sleeps,
    calls: () => calls,
    call: async () => {
      calls += 1;
      const next = queue.shift();
      if (!next) throw new Error("fake upstream ran out of responses");
      return next;
    },
    onRateLimited: (event: RateLimitedEvent) => {
      events.push(event);
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}

describe("retryAfterDelayMs", () => {
  it("reads the seconds form", () => {
    assert.equal(retryAfterDelayMs("1", NOW), 1000);
    assert.equal(retryAfterDelayMs("0", NOW), 0);
    assert.equal(retryAfterDelayMs(" 2 ", NOW), 2000);
  });

  it("reads the HTTP-date form and never returns a negative wait", () => {
    assert.equal(retryAfterDelayMs("Fri, 16 Oct 2026 20:00:01 GMT", NOW), 1000);
    assert.equal(retryAfterDelayMs("Fri, 16 Oct 2026 19:59:59 GMT", NOW), 0);
  });

  it("returns null for a missing or unparseable value", () => {
    assert.equal(retryAfterDelayMs(null, NOW), null);
    assert.equal(retryAfterDelayMs(undefined, NOW), null);
    assert.equal(retryAfterDelayMs("", NOW), null);
    assert.equal(retryAfterDelayMs("soon", NOW), null);
    assert.equal(retryAfterDelayMs("1.5", NOW), null);
  });
});

describe("classifyUpstreamFailure", () => {
  it("treats 429 with a short Retry-After as retryable", () => {
    const verdict = classifyUpstreamFailure({
      status: 429,
      body: "slow down",
      retryAfter: "1",
      nowMs: NOW,
    });
    assert.deepEqual(verdict, { rateLimited: true, retryDelayMs: 1000 });
  });

  it("does not retry a 429 without Retry-After, or with one longer than the cap", () => {
    assert.deepEqual(
      classifyUpstreamFailure({ status: 429, body: "slow down", retryAfter: null, nowMs: NOW }),
      {
        rateLimited: true,
        retryDelayMs: null,
      },
    );
    assert.deepEqual(
      classifyUpstreamFailure({ status: 429, body: "slow down", retryAfter: "5", nowMs: NOW }),
      {
        rateLimited: true,
        retryDelayMs: null,
      },
    );
    assert.equal(MAX_RETRY_AFTER_MS, 2000);
  });

  it("recognises a throttling body under another status", () => {
    for (const body of [
      JSON.stringify({
        error: { message: "Rate limit reached for requests", type: "rate_limit_error" },
      }),
      "Too many requests, please retry later",
      "request throttled by provider",
      "quota exceeded for this model",
    ]) {
      const verdict = classifyUpstreamFailure({ status: 500, body, retryAfter: "1", nowMs: NOW });
      assert.equal(verdict.rateLimited, true, body);
      assert.equal(verdict.retryDelayMs, 1000);
    }
  });

  it("leaves a real failure alone", () => {
    assert.deepEqual(
      classifyUpstreamFailure({ status: 500, body: "internal error", retryAfter: "1", nowMs: NOW }),
      {
        rateLimited: false,
        retryDelayMs: null,
      },
    );
    assert.deepEqual(
      classifyUpstreamFailure({ status: 400, body: "bad model ref", retryAfter: null, nowMs: NOW }),
      {
        rateLimited: false,
        retryDelayMs: null,
      },
    );
  });
});

describe("callModelWithRateLimitRetry", () => {
  it("returns the response untouched when the upstream is fine", async () => {
    const h = harness([ok()]);
    const response = await callModelWithRateLimitRetry(h);
    assert.equal(response?.status, 200);
    assert.equal(h.calls(), 1);
    assert.deepEqual(h.events, []);
    assert.deepEqual(h.sleeps, []);
  });

  it("retries exactly once after the wait the upstream asked for", async () => {
    const h = harness([fail(429, { error: "rate limit" }, { "retry-after": "1" }), ok()]);
    const response = await callModelWithRateLimitRetry(h);
    assert.equal(response?.status, 200);
    assert.equal(h.calls(), 2);
    assert.deepEqual(h.sleeps, [1000]);
    assert.deepEqual(h.events, [{ attempt: 1, status: 429, retryDelayMs: 1000 }]);
  });

  it("gives up after the one retry and reports both attempts", async () => {
    const h = harness([
      fail(429, "slow down", { "retry-after": "1" }),
      fail(429, "still slow", { "retry-after": "1" }),
    ]);
    const response = await callModelWithRateLimitRetry(h);
    assert.equal(
      response,
      null,
      "a still-busy upstream means the busy screen, not an invented answer",
    );
    assert.equal(h.calls(), 2);
    assert.deepEqual(h.sleeps, [1000]);
    assert.deepEqual(h.events, [
      { attempt: 1, status: 429, retryDelayMs: 1000 },
      { attempt: 2, status: 429, retryDelayMs: 1000 },
    ]);
  });

  it("does not retry at all when there is no usable Retry-After", async () => {
    const h = harness([fail(429, "slow down")]);
    assert.equal(await callModelWithRateLimitRetry(h), null);
    assert.equal(h.calls(), 1);
    assert.deepEqual(h.sleeps, []);
    assert.deepEqual(h.events, [{ attempt: 1, status: 429, retryDelayMs: null }]);
  });

  it("does not wait seconds on a voice turn when Retry-After is too long", async () => {
    const h = harness([fail(429, "slow down", { "retry-after": "30" })]);
    assert.equal(await callModelWithRateLimitRetry(h), null);
    assert.equal(h.calls(), 1);
    assert.deepEqual(h.sleeps, []);
  });

  it("surfaces a non-rate-limit failure as the real MODEL_HTTP error", async () => {
    const h = harness([fail(502, "bad gateway")]);
    await assert.rejects(
      () => callModelWithRateLimitRetry(h),
      /^Error: MODEL_HTTP_502:bad gateway$/,
    );
    assert.deepEqual(h.events, []);
    assert.deepEqual(h.sleeps, []);
  });

  it("uses the real clock and timer by default", async () => {
    const h = harness([fail(429, "slow down", { "retry-after": "0" }), ok()]);
    const started = Date.now();
    const response = await callModelWithRateLimitRetry({
      call: h.call,
      onRateLimited: h.onRateLimited,
    });
    assert.equal(response?.status, 200);
    assert.ok(Date.now() - started < 300, "a 0-second Retry-After must not sleep for long");
  });
});

describe("busyScreen", () => {
  it("tells an Arabic caller the service is busy, in Arabic, with only a home recovery", () => {
    const screen = busyScreen("ar-EG");
    assert.equal(screen.screen.text, "الخدمة مشغولة دلوقتي، جرّب بعد ثواني.");
    assert.deepEqual(screen.screen.navigation, ["home"]);
    assert.deepEqual(screen.screen.choices, []);
    assert.equal(screen.kind, "screen");
    assert.equal(screen.action_proposal, null);
    assert.deepEqual(screen.app_commands, []);
    assert.ok(screen.screen.text.length <= 240, "the console caps spoken text at 240 characters");
  });

  it("answers an English caller in English, and has no emoji or markdown in either", () => {
    const english = busyScreen("en-GB");
    assert.equal(
      english.screen.text,
      "The service is busy right now. Please try again in a few seconds.",
    );
    for (const screen of [busyScreen("ar"), english]) {
      assert.doesNotMatch(screen.screen.text, /[\p{Extended_Pictographic}#*_`]/u);
      assert.ok(screen.screen.text.trim().length > 0);
      assert.equal(screen.screen.text.length <= 240, true);
    }
  });

  it("states no result: it cannot be read as a confirmed booking", () => {
    for (const screen of [busyScreen("ar-EG"), busyScreen("en-US")]) {
      assert.doesNotMatch(screen.screen.text, /تم|مؤكد|booked|confirmed|احجز/i);
    }
  });
});
