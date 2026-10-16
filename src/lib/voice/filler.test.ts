import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  FILLER_DELAY_MS,
  FILLERS,
  containsArabic,
  createFillerScheduler,
  fillerFor,
  shouldSpeakFiller,
} from "./filler.ts";

afterEach(() => mock.timers.reset());

describe("containsArabic", () => {
  it("spots Arabic letters anywhere in the transcript", () => {
    assert.equal(containsArabic("إيه المواعيد المتاحة؟"), true);
    assert.equal(containsArabic("عايز دكتور يوسف"), true);
    assert.equal(containsArabic("OK السبت"), true);
    assert.equal(containsArabic("what is available on Saturday?"), false);
    assert.equal(containsArabic("4:30"), false);
    assert.equal(containsArabic(""), false);
  });
});

describe("fillerFor", () => {
  it("rotates the Arabic phrases for an Arabic transcript", () => {
    const first = fillerFor("إيه المواعيد المتاحة؟", 0);
    const second = fillerFor("إيه المواعيد المتاحة؟", 1);
    const third = fillerFor("إيه المواعيد المتاحة؟", 2);
    assert.equal(first.text, FILLERS.ar[0]);
    assert.equal(second.text, FILLERS.ar[1]);
    assert.equal(third.text, FILLERS.ar[0], "rotation wraps");
    assert.deepEqual([first.rotation, second.rotation, third.rotation], [1, 2, 3]);
  });

  it("answers an English transcript in English", () => {
    const pick = fillerFor("what's available?", 0);
    assert.equal(pick.text, "One moment, please.");
    assert.equal(fillerFor("what's available?", 7).text, FILLERS.en[0]);
  });

  it("never leaks a result or a question into the filler", () => {
    for (const phrase of [...FILLERS.ar, ...FILLERS.en]) {
      assert.doesNotMatch(phrase, /\d/, `${phrase} must not contain a number`);
      assert.doesNotMatch(phrase, /[?؟]/, `${phrase} must not ask anything`);
      assert.ok(phrase.length <= 20, `${phrase} stays short`);
    }
  });
});

describe("shouldSpeakFiller", () => {
  const allowed = {
    voiceInput: true,
    voiceRepliesEnabled: true,
    alreadySpoken: false,
    answerArrived: false,
    cancelled: false,
  };

  it("allows exactly one filler for an unanswered voice turn", () => {
    assert.equal(shouldSpeakFiller(allowed), true);
  });

  it("refuses a typed turn, a muted console, a second filler, a late answer and an aborted turn", () => {
    assert.equal(shouldSpeakFiller({ ...allowed, voiceInput: false }), false);
    assert.equal(shouldSpeakFiller({ ...allowed, voiceRepliesEnabled: false }), false);
    assert.equal(shouldSpeakFiller({ ...allowed, alreadySpoken: true }), false);
    assert.equal(shouldSpeakFiller({ ...allowed, answerArrived: true }), false);
    assert.equal(shouldSpeakFiller({ ...allowed, cancelled: true }), false);
  });
});

describe("filler scheduler", () => {
  function scheduler(delayMs = FILLER_DELAY_MS) {
    const spoken: Array<{ text: string; signal: AbortSignal }> = [];
    const errors: string[] = [];
    const s = createFillerScheduler({
      delayMs,
      speak: (text, signal) => spoken.push({ text, signal }),
      onError: (message) => errors.push(message),
    });
    return { s, spoken, errors };
  }

  it("speaks once, after the delay, in the caller's language", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { s, spoken } = scheduler();
    s.arm("إيه المواعيد المتاحة؟", { voiceInput: true, voiceRepliesEnabled: true });
    mock.timers.tick(FILLER_DELAY_MS - 1);
    assert.equal(spoken.length, 0, "nothing before the delay");
    mock.timers.tick(1);
    assert.equal(spoken.length, 1);
    assert.equal(spoken[0]?.text, FILLERS.ar[0]);
    assert.equal(s.spoken(), FILLERS.ar[0]);
  });

  it("speaks only once per turn however long the turn takes", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { s, spoken } = scheduler();
    s.arm("hello", { voiceInput: true, voiceRepliesEnabled: true });
    mock.timers.tick(FILLER_DELAY_MS * 10);
    assert.equal(spoken.length, 1);
    assert.equal(spoken[0]?.text, "One moment, please.");
  });

  it("stays silent when the answer beats the delay", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { s, spoken } = scheduler();
    s.arm("إيه المواعيد المتاحة؟", { voiceInput: true, voiceRepliesEnabled: true });
    mock.timers.tick(400);
    s.answerArrived();
    mock.timers.tick(FILLER_DELAY_MS * 5);
    assert.equal(spoken.length, 0);
  });

  it("stays silent for a typed turn and when voice replies are off", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { s, spoken } = scheduler();
    s.arm("type a message", { voiceInput: false, voiceRepliesEnabled: true });
    mock.timers.tick(FILLER_DELAY_MS * 3);
    assert.equal(spoken.length, 0);
    s.arm("voice turn but muted", { voiceInput: true, voiceRepliesEnabled: false });
    mock.timers.tick(FILLER_DELAY_MS * 3);
    assert.equal(spoken.length, 0);
  });

  it("stops the filler audio the moment the answer arrives, and never restarts it", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { s, spoken } = scheduler();
    s.arm("hello", { voiceInput: true, voiceRepliesEnabled: true });
    mock.timers.tick(FILLER_DELAY_MS);
    const signal = spoken[0]?.signal;
    assert.equal(signal?.aborted, false);
    s.answerArrived();
    assert.equal(signal?.aborted, true, "the reply must not overlap the filler");
    mock.timers.tick(FILLER_DELAY_MS * 2);
    assert.equal(spoken.length, 1);
  });

  it("drops a pending filler when the turn is aborted", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { s, spoken } = scheduler();
    s.arm("إيه المواعيد المتاحة؟", { voiceInput: true, voiceRepliesEnabled: true });
    s.cancel();
    mock.timers.tick(FILLER_DELAY_MS * 4);
    assert.equal(spoken.length, 0);
  });

  it("reports a speaking failure instead of throwing into the timer", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const errors: string[] = [];
    const s = createFillerScheduler({
      speak: () => {
        throw new Error("device voice is missing");
      },
      onError: (message) => errors.push(message),
    });
    s.arm("hello", { voiceInput: true, voiceRepliesEnabled: true });
    mock.timers.tick(FILLER_DELAY_MS);
    assert.deepEqual(errors, ["device voice is missing"]);
  });

  it("rotates on the next turn and resets its state for it", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { s, spoken } = scheduler();
    s.arm("إيه المواعيد المتاحة؟", { voiceInput: true, voiceRepliesEnabled: true });
    mock.timers.tick(FILLER_DELAY_MS);
    s.answerArrived();
    s.cancel();
    s.arm("وإيه كمان؟", { voiceInput: true, voiceRepliesEnabled: true });
    mock.timers.tick(FILLER_DELAY_MS);
    assert.deepEqual(
      spoken.map((entry) => entry.text),
      [FILLERS.ar[0], FILLERS.ar[1]],
      "the second turn gets the next phrase",
    );
  });
});
