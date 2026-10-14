import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { roomChoices, roomPages } from "./xr-room.ts";
import { parseScreen } from "./voice/screen.ts";

describe("spatial conversation", () => {
  test("long replies are fully readable rather than truncated", () => {
    const text = "x".repeat(1600);
    const pages = roomPages([{ id: "a", role: "assistant", text }]);
    assert.equal(pages.map((page) => page.text).join(""), text);
    assert.equal(pages.every((page) => page.text.length <= 440), true);
  });
  test("only the current assistant screen offers actions", () => {
    const assistant = { id: "a", role: "assistant" as const, text: "Choose", screen: { text: "Choose", choices: [{ id: "plan", label: "Plan", value: "Show plan" }], navigation: ["cancel" as const] } };
    assert.deepEqual(roomChoices([assistant]), [{ label: "Plan", value: "Show plan" }, { label: "Cancel", value: "cancel" }]);
    assert.deepEqual(roomChoices([assistant, { id: "b", role: "user", text: "New request" }]), []);
  });
  test("parses OpenClaw action proposals for human-in-the-loop approval", () => {
    const parsed = parseScreen(JSON.stringify({
      kind: "screen",
      screen: { text: "I prepared a firewall rule update.", choices: [], navigation: ["cancel"] },
      action_proposal: { id: "act_1", title: "Block IP 203.0.113.9", tool: "firewall.block_ip", summary: "Adds a deny rule on edge firewall", risk: "high" },
      app_commands: [],
    }));
    assert.equal(parsed?.actionProposal?.id, "act_1");
    assert.equal(parsed?.actionProposal?.tool, "firewall.block_ip");
    assert.equal(parsed?.actionProposal?.risk, "high");
  });
});