import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone } from "./phone.server.ts";

describe("normalizePhone", () => {
  const valid: Array<[string, string]> = [
    ["01001112223", "+201001112223"],
    ["٢٠١٠٠١١١٢٢٢٣", "+201001112223"],
    ["۲۰1001112223", "+201001112223"],
    ["+201001112223", "+201001112223"],
    ["00201001112223", "+201001112223"],
    ["201001112223", "+201001112223"],
    ["(+20) 100-111-2223", "+201001112223"],
    ["+14155552671", "+14155552671"],
  ];

  for (const [input, expected] of valid) {
    it(`normalizes ${input}`, () => {
      assert.equal(normalizePhone(input), expected);
    });
  }

  const invalid = [
    "",
    "  ",
    "0100",
    "155552671",
    "+000123456",
    "+20",
    "hello",
  ];

  for (const input of invalid) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      assert.equal(normalizePhone(input), null);
    });
  }
});
