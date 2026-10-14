import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveGatewayModel } from "./models.ts";

describe("resolveGatewayModel", () => {
  it("maps a portfolio chip or openclaw route to its gateway model", () => {
    assert.equal(resolveGatewayModel("gpt-5.6-terra"), "openai/gpt-5.6-terra");
    assert.equal(resolveGatewayModel("gemini-3.1-pro"), "google/gemini-3.1-pro-preview");
    assert.equal(resolveGatewayModel("openclaw/researcher"), "openclaw/researcher");
  });
  it("uses the default model when none is picked", () => {
    assert.equal(resolveGatewayModel(undefined), "openai/gpt-6-astra");
  });
  it("refuses unknown models instead of swapping them", () => {
    assert.equal(resolveGatewayModel("gpt-5.6-sol-pro"), null);
  });
});
