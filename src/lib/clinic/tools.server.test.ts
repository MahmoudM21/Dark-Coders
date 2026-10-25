import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fullNameProblem, runTool } from "./tools.server.ts";

describe("runTool", () => {
  it("returns validation error for bad args", async () => {
    const result = await runTool("select_branch", { branch_ref: "" }, { session_id: "11111111-1111-4111-8111-111111111111", request_id: "r1" }, {
      auditInsert: async () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "VALIDATION_ERROR");
    assert.equal(result.error.details?.["field"], "branch_ref");
    assert.equal(typeof result.meta.latency_ms, "number");
  });

  it("wraps successful rpc responses", async () => {
    const result = await runTool("get_clinic_info", {}, { session_id: "11111111-1111-4111-8111-111111111111", request_id: "r2" }, {
      callRpcFn: async () => ({ ok: true, data: { clinic_name: "Demo" } }),
      auditInsert: async () => {},
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal((result.data as { clinic_name: string }).clinic_name, "Demo");
  });

  it("dispatches find_doctor to clinic_find_doctor with the query", async () => {
    const seen: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const result = await runTool(
      "find_doctor",
      { query: "يوسف" },
      { session_id: "33333333-3333-4333-8333-333333333333", request_id: "r3" },
      {
        callRpcFn: async (fn, args) => {
          seen.push({ fn, args });
          return { ok: true, data: { doctors: [{ doctor_ref: "dr-yousef-el-refaie" }] } };
        },
        auditInsert: async () => {},
      },
    );
    assert.equal(result.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.fn, "clinic_find_doctor");
    assert.equal(seen[0]?.args["p_query"], "يوسف");
    assert.equal(seen[0]?.args["p_session"], "33333333-3333-4333-8333-333333333333");
  });

  it("rejects find_doctor without a query before any RPC happens", async () => {
    let called = false;
    const result = await runTool(
      "find_doctor",
      {},
      { session_id: "33333333-3333-4333-8333-333333333333", request_id: "r4" },
      {
        callRpcFn: async () => {
          called = true;
          return { ok: true, data: {} };
        },
        auditInsert: async () => {},
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "VALIDATION_ERROR");
    assert.equal(result.error.details?.["field"], "query");
    assert.equal(called, false);
  });

  it("stores the appointment_ref of a successful booking change on the audit row", async () => {
    const audit: Array<Record<string, unknown>> = [];
    const result = await runTool(
      "confirm_booking",
      { approval_id: "apr_123456789012" },
      { session_id: "44444444-4444-4444-8444-444444444444", request_id: "r5" },
      {
        callRpcFn: async () => ({
          ok: true,
          data: { appointment_ref: "a1b2c3", status: "booked" },
        }),
        auditInsert: async (entry) => {
          audit.push(entry);
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(audit.length, 1);
    const input = audit[0]?.["input"] as Record<string, unknown> | undefined;
    assert.equal(input?.["result_ref"], "A1B2C3");
    assert.equal(audit[0]?.["outcome"], "ok");
  });

  it("never stores a result_ref for a failed booking change", async () => {
    const audit: Array<Record<string, unknown>> = [];
    await runTool(
      "confirm_booking",
      { approval_id: "apr_123456789013" },
      { session_id: "44444444-4444-4444-8444-444444444444", request_id: "r6" },
      {
        callRpcFn: async () => ({
          ok: false,
          error: { code: "APPROVAL_PENDING", message: "Waiting for approval" },
        }),
        auditInsert: async (entry) => {
          audit.push(entry);
        },
      },
    );
    const input = audit[0]?.["input"] as Record<string, unknown> | undefined;
    assert.equal(input?.["result_ref"], undefined);
    assert.equal(audit[0]?.["outcome"], "error");
  });

  it("does not attach a result_ref to a tool that does not change a booking", async () => {
    const audit: Array<Record<string, unknown>> = [];
    await runTool(
      "find_doctor",
      { query: "يوسف" },
      { session_id: "44444444-4444-4444-8444-444444444444", request_id: "r7" },
      {
        callRpcFn: async () => ({ ok: true, data: { appointment_ref: "A1B2C3" } }),
        auditInsert: async (entry) => {
          audit.push(entry);
        },
      },
    );
    const input = audit[0]?.["input"] as Record<string, unknown> | undefined;
    assert.equal(input?.["result_ref"], undefined);
  });

  it("applies rate limiting", async () => {
    const calls: number[] = [];
    let now = 1;
    const deps = {
      callRpcFn: async () => ({ ok: true, data: {} }),
      auditInsert: async () => {},
      now: () => now,
    };
    for (let i = 0; i < 30; i++) {
      calls.push(i);
      const result = await runTool("get_clinic_info", {}, { session_id: "22222222-2222-4222-8222-222222222222", request_id: `r-${i}` }, deps);
      assert.equal(result.ok, true);
      now += 1;
    }
    const blocked = await runTool("get_clinic_info", {}, { session_id: "22222222-2222-4222-8222-222222222222", request_id: "blocked" }, deps);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, "RATE_LIMITED");
  });
});

describe("runTool — dedupe", () => {
  const SESSION = "66666666-6666-4666-8666-666666666666";

  function deps(rpcs: Array<{ fn: string; args: Record<string, unknown> }>, clock: { now: number }, result?: unknown) {
    return {
      callRpcFn: (async (fn: string, args: Record<string, unknown>) => {
        rpcs.push({ fn, args });
        return result ?? { ok: true, data: { doctors: [] } };
      }) as never,
      auditInsert: async () => {},
      now: () => clock.now,
    };
  }

  it("answers an identical call inside the window from the previous result", async () => {
    const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const audit: Array<Record<string, unknown>> = [];
    const clock = { now: 1_000_000 };
    const base = deps(rpcs, clock);
    const d = { ...base, auditInsert: async (entry: Record<string, unknown>) => void audit.push(entry) };
    const first = await runTool("find_doctor", { query: "يوسف" }, { session_id: SESSION, request_id: "a" }, d);
    clock.now += 5_000;
    const second = await runTool("find_doctor", { query: "يوسف" }, { session_id: SESSION, request_id: "b" }, d);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.meta.deduped, true);
    assert.equal(rpcs.length, 1);
    // The repeat is audited as such, so the model's repetition stays measurable.
    assert.deepEqual(audit.map((entry) => entry["event"]), ["tool_call", "tool_deduped"]);
    assert.equal((audit[1]?.["input"] as Record<string, unknown>)["reason"], "repeat_window");
  });

  it("executes again after the window", async () => {
    const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const clock = { now: 2_000_000 };
    const d = deps(rpcs, clock);
    await runTool("find_doctor", { query: "يوسف" }, { session_id: SESSION, request_id: "a" }, d);
    clock.now += 15_000;
    const second = await runTool("find_doctor", { query: "يوسف" }, { session_id: SESSION, request_id: "b" }, d);
    assert.equal(second.meta.deduped, undefined);
    assert.equal(rpcs.length, 2);
  });

  it("never caches an error", async () => {
    const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const clock = { now: 3_000_000 };
    const d = deps(rpcs, clock, { ok: false, error: { code: "DB_ERROR", message: "boom" } });
    const first = await runTool("find_doctor", { query: "يوسف" }, { session_id: SESSION, request_id: "a" }, d);
    clock.now += 1_000;
    const second = await runTool("find_doctor", { query: "يوسف" }, { session_id: SESSION, request_id: "b" }, d);
    assert.equal(first.ok, false);
    assert.equal(second.ok, false);
    assert.equal(rpcs.length, 2);
  });

  it("dedupes escalate_to_human for a minute whatever the arguments", async () => {
    const escalations: Array<Record<string, unknown>> = [];
    const clock = { now: 4_000_000 };
    const d = {
      escalateFn: (async (_session: string, args: Record<string, unknown>) => {
        escalations.push(args);
        return { ok: true, data: { escalation_id: "e1", route: "notify_contact", within_hours: true, delivery_status: "notified", emergency_services_number: "123", clinic_phone: "+20" } };
      }) as never,
      auditInsert: async () => {},
      now: () => clock.now,
    };
    await runTool(
      "escalate_to_human",
      { severity: "emergency", reason: "chest_pain", summary: "first" },
      { session_id: SESSION, request_id: "a" },
      d,
    );
    clock.now += 30_000;
    const second = await runTool(
      "escalate_to_human",
      { severity: "urgent", reason: "other", summary: "second" },
      { session_id: SESSION, request_id: "b" },
      d,
    );
    assert.equal(second.ok, true);
    assert.equal(second.meta.deduped, true);
    assert.equal(escalations.length, 1);
  });

  it("writes one note of a kind a minute", async () => {
    const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const clock = { now: 5_000_000 };
    const d = deps(rpcs, clock, { ok: true, data: { note_id: "n1" } });
    await runTool("add_note", { kind: "summary", body: "Booked Saturday" }, { session_id: SESSION, request_id: "a" }, d);
    clock.now += 20_000;
    const second = await runTool("add_note", { kind: "summary", body: "Booked Saturday" }, { session_id: SESSION, request_id: "b" }, d);
    clock.now += 1_000;
    const otherKind = await runTool("add_note", { kind: "note", body: "Booked Saturday" }, { session_id: SESSION, request_id: "c" }, d);
    assert.equal(second.ok, true);
    assert.equal(second.meta.deduped, true);
    assert.equal(otherKind.meta.deduped, undefined);
    assert.equal(rpcs.length, 2);
  });
});

describe("runTool — identify_patient names", () => {
  const SESSION = "77777777-7777-4777-8777-777777777777";

  for (const bad of ["مع", "اسمي", "i am", "ab"]) {
    it(`rejects ${JSON.stringify(bad)} as a full name`, async () => {
      let called = false;
      const result = await runTool(
        "identify_patient",
        { full_name: bad, phone: "01001112223" },
        { session_id: SESSION, request_id: `bad-${bad}` },
        {
          callRpcFn: (async () => {
            called = true;
            return { ok: true, data: {} };
          }) as never,
          auditInsert: async () => {},
        },
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.error.code, "VALIDATION_ERROR");
      assert.equal(result.error.details?.["field"], "full_name");
      assert.equal(result.error.agent_action, "ask_again");
      assert.equal(called, false);
    });
  }

  for (const good of ["محمد علي", "Sara Ali", "علي"]) {
    it(`accepts ${JSON.stringify(good)} and collapses its whitespace`, async () => {
      const seen: Array<Record<string, unknown>> = [];
      const result = await runTool(
        "identify_patient",
        { full_name: `  ${good.replace(" ", "   ")}  `, phone: "01001112223" },
        { session_id: SESSION, request_id: `good-${good}` },
        {
          callRpcFn: (async (_fn: string, args: Record<string, unknown>) => {
            seen.push(args);
            return { ok: true, data: { patient_ref: "p1" } };
          }) as never,
          auditInsert: async () => {},
        },
      );
      assert.equal(result.ok, true);
      assert.equal(seen[0]?.["p_full_name"], good);
    });
  }

  it("classifies names the same way in the exported helper", () => {
    assert.equal(fullNameProblem("مع"), "fewer than 3 letters");
    assert.equal(fullNameProblem("   "), "empty");
    assert.equal(fullNameProblem("the name"), "every word is a stopword");
    assert.equal(fullNameProblem("محمد علي"), null);
  });
});
