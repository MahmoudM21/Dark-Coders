import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runTool } from "./tools.server.ts";

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
