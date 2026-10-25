import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { streamAgentAnswer, type FailedStep } from "./agent.ts";

function sseResponse(events: unknown[]) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** Runs one turn against a fake bridge response and returns the steps the console would log. */
async function readTurn(events: unknown[]): Promise<{ answer: string; steps: FailedStep[] }> {
  const steps: FailedStep[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => sseResponse(events)) as typeof fetch;
  try {
    const answer = await streamAgentAnswer(
      [{ role: "user", text: "hello" }],
      {
        onThinking: () => {},
        onAnswer: () => {},
        onFailedStep: (step) => void steps.push(step),
      },
    );
    return { answer, steps };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("streamAgentAnswer — bridge.failed_step", () => {
  it("reports a TURN_DEADLINE step and still returns the screen the bridge sent", async () => {
    const screen = JSON.stringify({ kind: "screen", screen: { text: "جرّب تاني", choices: [], navigation: ["home"] } });
    const { answer, steps } = await readTurn([
      { type: "bridge.failed_step", code: "TURN_DEADLINE", detail: "Failed step: TURN_DEADLINE — no answer within 60000 ms", tone: "error" },
      { type: "response.output_text.done", text: screen },
    ]);
    assert.equal(answer, screen);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.code, "TURN_DEADLINE");
    assert.match(steps[0]?.detail ?? "", /TURN_DEADLINE/);
    assert.equal(steps[0]?.tone, "error");
  });

  it("reports a blocked confirmation as a guarded step", async () => {
    const { steps } = await readTurn([
      { type: "bridge.failed_step", code: "FALSE_CONFIRMATION", detail: "blocked a ar_booked claim", tone: "warn" },
      { type: "response.output_text.done", text: JSON.stringify({ kind: "screen", screen: { text: "لسه ما اتأكدش حاجة." } }) },
    ]);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.code, "FALSE_CONFIRMATION");
    assert.equal(steps[0]?.tone, "warn");
  });

  it("never calls the handler when the bridge reports no failed step", async () => {
    const { steps } = await readTurn([
      { type: "bridge.timing", timing: { total_ms: 1200 } },
      { type: "response.output_text.done", text: JSON.stringify({ kind: "screen", screen: { text: "أهلاً" } }) },
    ]);
    assert.deepEqual(steps, []);
  });
});
