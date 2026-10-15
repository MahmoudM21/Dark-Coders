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
