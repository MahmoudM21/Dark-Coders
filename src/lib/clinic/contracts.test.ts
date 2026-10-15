import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_ACTION,
  ERROR_CODES,
  fail,
  toolInputSchemas,
} from "./contracts.ts";

describe("clinic contracts", () => {
  it("maps every error code to an agent action", () => {
    for (const code of ERROR_CODES) assert.ok(AGENT_ACTION[code], `missing action for ${code}`);
  });

  it("rejects malformed tool inputs with zod", () => {
    const badBranch = toolInputSchemas.select_branch.safeParse({ branch_ref: "" });
    assert.equal(badBranch.success, false);

    const badAvailability = toolInputSchemas.check_availability.safeParse({ from: "bad", to: "also bad" });
    assert.equal(badAvailability.success, false);

    const badEscalation = toolInputSchemas.escalate_to_human.safeParse({ severity: "invalid", reason: "x", summary: "y" });
    assert.equal(badEscalation.success, false);
  });

  it("builds error envelopes with retryability and action", () => {
    const err = fail("DB_ERROR", "db down");
    assert.equal(err.ok, false);
    assert.equal(err.error.code, "DB_ERROR");
    assert.equal(typeof err.error.retryable, "boolean");
    assert.equal(typeof err.error.agent_action, "string");
  });
});
