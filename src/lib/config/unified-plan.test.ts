import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePlan, exportRoadmap } from "./unified-plan.ts";

describe("architecture YAML stays specification data", () => {
  it("reads nested requirements without treating them as controls", () => {
    assert.deepEqual(parsePlan("voice:\n  input:\n    enabled: true").features, [
      { path: "voice.input.enabled", value: "true", group: "voice" },
    ]);
  });
  it("exports reviews without granting deployment authority", () => {
    assert.equal(exportRoadmap({ source: "", statuses: { "voice.input": "reviewed" } }).includes("deployment_authority: false"), true);
  });
  it("rejects duplicate fields", () => {
    assert.throws(() => parsePlan("voice: true\nvoice: false"));
  });
});