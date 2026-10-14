import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { transcriptionUrl } from "./local-asr.ts";

describe("configured local transcription", () => {
  it("keeps local service calls on the chosen host", () => {
    assert.equal(transcriptionUrl("http://localhost:8000/v1/"), "http://localhost:8000/v1/audio/transcriptions");
  });
  it("rejects credentials embedded in server addresses", () => {
    assert.throws(() => transcriptionUrl("https://user:secret@localhost/v1"));
  });
  it("rejects executable URL protocols", () => {
    assert.throws(() => transcriptionUrl("javascript:alert(1)"));
  });
});