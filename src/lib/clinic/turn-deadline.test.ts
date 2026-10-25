import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  DEFAULT_TURN_DEADLINE_MS,
  deadlineScreen,
  deadlineStep,
  runWithDeadline,
  startTurnDeadline,
  turnDeadlineMs,
} from "./turn-deadline.ts";

/**
 * A fake upstream that sends SSE headers and one chunk, then hangs forever. It records
 * whether the client's connection was actually closed — the property the bridge relies on.
 */
async function hangingUpstream(): Promise<{ server: Server; closed: boolean; requests: number; url: () => string }> {
  const state = { closed: false, requests: 0, port: 0 };
  const server = createServer((req, res) => {
    state.requests += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"{"}}]}\n\n');
    req.on("close", () => {
      state.closed = true;
    });
    res.on("close", () => {
      state.closed = true;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    get closed() {
      return state.closed;
    },
    get requests() {
      return state.requests;
    },
    url: () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server has no port");
      return `http://127.0.0.1:${address.port}/v1/chat/completions`;
    },
  };
}

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

describe("runWithDeadline", () => {
  it("aborts a hanging upstream and records the elapsed time", async () => {
    const upstream = await hangingUpstream();
    servers.push(upstream.server);

    const result = await runWithDeadline(300, async (signal) => {
      const response = await fetch(upstream.url(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "fake", stream: true }),
        signal,
      });
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) return "upstream finished";
      }
    });

    assert.equal(result.timedOut, true);
    if (!result.timedOut) return;
    assert.ok(result.elapsedMs >= 250, `elapsed ${result.elapsedMs} ms should be at least the deadline`);
    assert.equal(upstream.requests, 1);
    // The abort must close the connection, not leave the request running.
    assert.equal(await waitFor(() => upstream.closed, 2000), true, "the upstream socket was never closed");
  });

  it("returns the value and never aborts when the work finishes in time", async () => {
    const result = await runWithDeadline(5000, async () => "fast");
    assert.equal(result.timedOut, false);
    if (result.timedOut) return;
    assert.equal(result.value, "fast");
  });

  it("rethrows the work's own error instead of reporting a timeout", async () => {
    await assert.rejects(
      () =>
        runWithDeadline(5000, async () => {
          throw new Error("upstream said 500");
        }),
      /upstream said 500/,
    );
  });

  it("does not leave an unhandled rejection after timing out", async () => {
    const upstream = await hangingUpstream();
    servers.push(upstream.server);
    const result = await runWithDeadline(150, async (signal) => {
      const response = await fetch(upstream.url(), { method: "POST", body: "{}", signal });
      const reader = response.body!.getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) return "done";
      }
    });
    assert.equal(result.timedOut, true);
    // Let the aborted read settle; an unhandled rejection would fail this test process.
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
});

describe("startTurnDeadline", () => {
  it("closes the upstream connection when the deadline fires", async () => {
    const upstream = await hangingUpstream();
    servers.push(upstream.server);
    const deadline = startTurnDeadline(200);

    const response = await fetch(upstream.url(), { method: "POST", body: "{}", signal: deadline.signal });
    const reader = response.body!.getReader();
    await assert.rejects(async () => {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
      }
    });

    assert.equal(deadline.signal.aborted, true);
    assert.equal(await deadline.fired, "timeout");
    assert.equal(typeof deadline.elapsedMs(), "number");
    assert.equal(await waitFor(() => upstream.closed, 2000), true, "the upstream socket was never closed");
    deadline.clear();
  });

  it("reports null elapsed time while the turn is still on time", () => {
    const deadline = startTurnDeadline(5000);
    assert.equal(deadline.signal.aborted, false);
    assert.equal(deadline.elapsedMs(), null);
    deadline.clear();
  });
});

describe("turnDeadlineMs", () => {
  it("defaults to 60 s, above the 51.7 s cold first turn", () => {
    assert.equal(DEFAULT_TURN_DEADLINE_MS, 60_000);
    assert.equal(turnDeadlineMs(undefined), 60_000);
    assert.equal(turnDeadlineMs(""), 60_000);
    assert.equal(turnDeadlineMs("0"), 60_000);
    assert.equal(turnDeadlineMs("-5"), 60_000);
    assert.equal(turnDeadlineMs("nonsense"), 60_000);
  });

  it("accepts a positive override in milliseconds", () => {
    assert.equal(turnDeadlineMs("90000"), 90_000);
    assert.equal(turnDeadlineMs("1500.9"), 1500);
  });
});

describe("deadline wording", () => {
  it("speaks the deadline in the caller's language with the number of seconds", () => {
    assert.equal(deadlineScreen("ar", 60), "الرد أخد وقت أطول من المسموح (60 ثانية). جرّب تاني.");
    assert.equal(deadlineScreen("en", 60), "That took longer than allowed (60 s). Please try again.");
  });

  it("shows the TURN_DEADLINE code in the failed-step line", () => {
    assert.equal(deadlineStep(60_000), "Failed step: TURN_DEADLINE — no answer within 60000 ms");
  });
});
