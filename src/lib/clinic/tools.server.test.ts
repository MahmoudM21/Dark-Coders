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
