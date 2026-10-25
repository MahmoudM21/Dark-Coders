import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EMERGENCY_NOTE_PREFIX, emergencyNote, emergencyPrecheck, precheckBeforeGateway } from "./emergency.server.ts";

const SESSION = "55555555-5555-4555-8555-555555555555";

type Call = { kind: string };

/** A fake escalation delivery that records the call and returns the real envelope shape. */
function fakeEscalate(calls: Call[], payloads: Record<string, unknown>[], result?: unknown) {
  return (async (sessionId: string, args: Record<string, unknown>) => {
    calls.push({ kind: "escalate" });
    payloads.push({ sessionId, ...args });
    return (
      result ?? {
        ok: true,
        data: {
          escalation_id: "e1",
          route: "notify_contact",
          within_hours: true,
          delivery_status: "notified",
          emergency_services_number: "123",
          clinic_phone: "+20 2 1234 5678",
        },
      }
    );
  }) as unknown as typeof import("./escalation.server.ts").escalate;
}

describe("precheckBeforeGateway", () => {
  it("escalates ONCE before the gateway is called, and puts the note in the request", async () => {
    const calls: Call[] = [];
    const payloads: Record<string, unknown>[] = [];
    const audit: Array<Record<string, unknown>> = [];
    let escalateCallsAtGateway = -1;
    let note: string | null = null;

    await precheckBeforeGateway(
      { text: "عندي ألم في الصدر ومش قادر اتنفس", sessionId: SESSION },
      async (emergencyNote) => {
        calls.push({ kind: "gateway" });
        escalateCallsAtGateway = calls.filter((call) => call.kind === "escalate").length;
        note = emergencyNote;
        return "ok";
      },
      { escalateFn: fakeEscalate(calls, payloads), audit: async (entry) => void audit.push(entry) },
    );

    assert.deepEqual(calls.map((call) => call.kind), ["escalate", "gateway"]);
    assert.equal(escalateCallsAtGateway, 1);
    assert.equal(payloads[0]?.["severity"], "emergency");
    assert.equal(payloads[0]?.["reason"], "chest_pain");
    assert.ok(note, "the gateway must receive the system note");
    assert.ok(note!.startsWith(EMERGENCY_NOTE_PREFIX));
    assert.match(note!, /delivery_status=notified/);
    assert.match(note!, /emergency_services_number=123/);
    assert.match(note!, /Do not offer booking this turn\./);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.["event"], "emergency_precheck");
    assert.equal(audit[0]?.["outcome"], "ok");
    assert.deepEqual(audit[0]?.["input"], { category: "chest_pain", delivery_status: "notified" });
  });

  it("never escalates and passes no note for an ordinary booking turn", async () => {
    const calls: Call[] = [];
    const payloads: Record<string, unknown>[] = [];
    const audit: Array<Record<string, unknown>> = [];
    let note: string | null | undefined = "unset";

    await precheckBeforeGateway(
      { text: "عايز أحجز كشف أسنان السبت", sessionId: SESSION },
      async (emergencyNote) => {
        calls.push({ kind: "gateway" });
        note = emergencyNote;
      },
      { escalateFn: fakeEscalate(calls, payloads), audit: async (entry) => void audit.push(entry) },
    );

    assert.deepEqual(calls.map((call) => call.kind), ["gateway"]);
    assert.equal(note, null);
    assert.equal(payloads.length, 0);
    assert.equal(audit.length, 0);
  });

  it("never escalates on a negated or historical symptom", async () => {
    const calls: Call[] = [];
    const payloads: Record<string, unknown>[] = [];
    let note: string | null | undefined = "unset";

    await precheckBeforeGateway(
      { text: "كان عندي ألم في الصدر من سنين", sessionId: SESSION },
      async (emergencyNote) => {
        note = emergencyNote;
      },
      { escalateFn: fakeEscalate(calls, payloads), audit: async () => {} },
    );

    assert.equal(note, null);
    assert.equal(payloads.length, 0);
  });
});

describe("emergencyPrecheck", () => {
  it("reports delivery_failed honestly when the escalation envelope fails", async () => {
    const calls: Call[] = [];
    const audit: Array<Record<string, unknown>> = [];

    const result = await emergencyPrecheck(
      { text: "عايز انتحر", sessionId: SESSION },
      {
        escalateFn: fakeEscalate(calls, [], { ok: false, error: { code: "DELIVERY_FAILED", message: "no webhook" } }),
        audit: async (entry) => void audit.push(entry),
      },
    );

    assert.equal(result.matched, true);
    if (!result.matched) return;
    assert.equal(result.delivery_status, "delivery_failed");
    assert.match(result.note, /delivery_status=delivery_failed/);
    assert.match(result.note, /emergency_services_number=not configured/);
    assert.equal(audit[0]?.["outcome"], "error");
  });

  it("treats a thrown delivery as delivery_failed and still audits it", async () => {
    const audit: Array<Record<string, unknown>> = [];
    const throwing = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof import("./escalation.server.ts").escalate;

    const result = await emergencyPrecheck(
      { text: "فقد الوعي", sessionId: SESSION },
      { escalateFn: throwing, audit: async (entry) => void audit.push(entry) },
    );

    assert.equal(result.matched, true);
    if (!result.matched) return;
    assert.equal(result.delivery_status, "delivery_failed");
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.["outcome"], "error");
  });

  it("masks digits in the summary it sends", async () => {
    const calls: Call[] = [];
    const payloads: Record<string, unknown>[] = [];

    await emergencyPrecheck(
      { text: "رقمي 01001112223 وعندي ألم في الصدر", sessionId: SESSION },
      { escalateFn: fakeEscalate(calls, payloads), audit: async () => {} },
    );

    assert.equal(payloads[0]?.["summary"], "رقمي # وعندي ألم في الصدر");
  });

  it("caps the summary at 200 characters", async () => {
    const calls: Call[] = [];
    const payloads: Record<string, unknown>[] = [];

    await emergencyPrecheck(
      { text: `عندي ألم في الصدر ${"و".repeat(500)}`, sessionId: SESSION },
      { escalateFn: fakeEscalate(calls, payloads), audit: async () => {} },
    );

    assert.equal(String(payloads[0]?.["summary"]).length, 200);
  });
});

describe("emergencyNote", () => {
  it("says only what the delivery status supports", () => {
    const note = emergencyNote("delivery_failed", "123");
    assert.equal(
      note,
      "ESCALATION ALREADY PERFORMED: delivery_status=delivery_failed, emergency_services_number=123. Do not claim anything beyond delivery_status. Do not offer booking this turn.",
    );
  });
});
