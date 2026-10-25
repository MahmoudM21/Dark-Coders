import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyEmergency, emergencySummary, normalizeForMatch, type EmergencyCategory } from "./emergency.ts";

/** Every phrase the brief named, plus the categories they must land in. */
const POSITIVES: ReadonlyArray<readonly [string, EmergencyCategory]> = [
  ["عندي ألم في الصدر", "chest_pain"],
  ["صدري بيوجعني جامد", "chest_pain"],
  ["مش قادر اتنفس", "breathing"],
  ["حاسس اني هتخنق", "breathing"],
  ["ابويا اغمي عليه", "unconscious"],
  ["فقد الوعي", "unconscious"],
  ["عنده تشنجات", "seizure"],
  ["النزيف مش بيقف بعد الخلع", "uncontrolled_bleeding"],
  ["وشه ورم ومش قادر يبلع", "airway_swelling"],
  ["حساسية شديدة وحلقي بيورم", "severe_allergy"],
  ["اخدت جرعة زيادة", "overdose_poisoning"],
  ["عايز انتحر", "self_harm"],
  ["chest pain", "chest_pain"],
  ["I can't breathe", "breathing"],
  ["he is unconscious", "unconscious"],
  ["she is having a seizure", "seizure"],
  ["bleeding won't stop", "uncontrolled_bleeding"],
  ["swollen throat can't swallow", "airway_swelling"],
  ["took an overdose", "overdose_poisoning"],
  ["severe allergic reaction", "severe_allergy"],
  ["I want to kill myself", "self_harm"],
  ["face drooping and slurred speech", "stroke_signs"],
];

/** Ordinary dental calls and explicit denials must never escalate. */
const NEGATIVES: readonly string[] = [
  "عندي ألم في الضرس",
  "وجع في سناني",
  "toothache",
  "my gum bleeds a little when I brush",
  "عايز احجز كشف",
  "ما عنديش ألم في الصدر",
  "I can breathe fine",
  "no chest pain",
  "كان عندي ألم في الصدر من سنين",
  "I had chest pain years ago",
  "مش بنام كويس",
  "عايز اعرف مواعيد الدكتور",
  "ورم بسيط في اللثة",
  "my tooth hurts when I drink cold water",
  "أهلاً، عايز أحجز كشف أسنان",
  "فرع المقطم",
  "اسمي محمد علي",
  "رقمي 01001112223",
  "What are your opening hours?",
  "عايز السبت بعد 5",
  "عندي حشو قديم محتاج مراجعة",
  "الضرس بيوجعني بس خفيف",
];

describe("classifyEmergency — positives", () => {
  for (const [text, category] of POSITIVES) {
    it(`triggers on: ${text}`, () => {
      const verdict = classifyEmergency(text);
      assert.equal(verdict.match, true);
      assert.equal(verdict.category, category);
    });
  }
});

describe("classifyEmergency — negatives", () => {
  for (const text of NEGATIVES) {
    it(`stays quiet on: ${text}`, () => {
      const verdict = classifyEmergency(text);
      assert.equal(verdict.match, false);
      assert.equal(verdict.category, null);
    });
  }
});

describe("classifyEmergency — details", () => {
  it("finds the symptom in a later clause of the same turn", () => {
    const verdict = classifyEmergency("عايز أحجز كشف. بس عندي ألم في الصدر من الصبح");
    assert.equal(verdict.match, true);
    assert.equal(verdict.category, "chest_pain");
  });

  it("ignores a symptom that is both negated and in the past", () => {
    assert.equal(classifyEmergency("مفيش ألم في الصدر ولا ضيق في النفس").match, false);
  });

  it("still triggers when the negation is further than three words away", () => {
    const verdict = classifyEmergency("ما عنديش مشكلة في الضرس بس عندي ألم في الصدر جامد");
    assert.equal(verdict.match, true);
    assert.equal(verdict.category, "chest_pain");
  });

  it("returns no match for empty or whitespace input", () => {
    assert.equal(classifyEmergency("").match, false);
    assert.equal(classifyEmergency("   ").match, false);
  });
});

describe("emergency helpers", () => {
  it("normalises diacritics, tatweel, alef/ya/ta-marbuta and Arabic-Indic digits", () => {
    assert.equal(normalizeForMatch("تَمَام"), "تمام");
    assert.equal(normalizeForMatch("ألم"), "الم");
    assert.equal(normalizeForMatch("إلغاء"), "الغاء");
    assert.equal(normalizeForMatch("سنى"), "سني");
    assert.equal(normalizeForMatch("سنة"), "سنه");
    assert.equal(normalizeForMatch("٠١٢٣٤٥٦٧٨٩"), "0123456789");
    assert.equal(normalizeForMatch("ـضرس"), "ضرس");
  });

  it("masks every digit run in the escalation summary", () => {
    assert.equal(emergencySummary("رقمي 01001112223 وعندي ألم في الصدر"), "رقمي # وعندي ألم في الصدر");
  });

  it("caps the summary at the given length", () => {
    const summary = emergencySummary("أ".repeat(400), 200);
    assert.equal(summary.length, 200);
    assert.equal(emergencySummary("ألم في الصدر", 200), "ألم في الصدر");
  });
});
