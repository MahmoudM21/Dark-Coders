import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIRMATION_REFUSAL,
  extractCodes,
  guardConfirmation,
  looksLikeAppointmentRef,
  normalizeArabic,
  type ConfirmationChoice,
  type ConfirmationSuccess,
} from "./confirmation-guard.ts";

const NO_CHOICES: ConfirmationChoice[] = [];

function guard(text: string, successes: ConfirmationSuccess[] = [], lang: "ar" | "en" = "ar") {
  return guardConfirmation({ text, choices: NO_CHOICES, lang, successes });
}

const BOOKED: ConfirmationSuccess[] = [{ tool: "confirm_booking", result_ref: "A1B2C3" }];

describe("guardConfirmation — Arabic declarative claims", () => {
  it("blocks تم الحجز when nothing ran this turn", () => {
    const result = guard("تم الحجز بنجاح، كود التأكيد A1B2C3");
    assert.equal(result.blocked, true);
    assert.equal(result.text, CONFIRMATION_REFUSAL.ar);
    if (result.blocked) assert.ok(result.pattern.startsWith("ar_"));
  });

  it("blocks تم تأكيد الحجز", () => {
    const result = guard("تم تأكيد الحجز يوم السبت الساعة 5.");
    assert.equal(result.blocked, true);
    assert.equal(result.text, CONFIRMATION_REFUSAL.ar);
  });

  it("blocks تم إلغاء", () => {
    const result = guard("تم إلغاء الموعد بناءً على طلبك.");
    assert.equal(result.blocked, true);
  });

  it("blocks تم تعديل", () => {
    const result = guard("تم تعديل الميعاد لبكرة الساعة 6.");
    assert.equal(result.blocked, true);
  });

  it("blocks حجزت لحضرتك", () => {
    const result = guard("حجزت لحضرتك يوم السبت الساعة 5 مع دكتور محمد علي.");
    assert.equal(result.blocked, true);
  });

  it("blocks الحجز اتأكد with رقم التأكيد", () => {
    const result = guard("الحجز اتأكد. رقم التأكيد 4F2A9C");
    assert.equal(result.blocked, true);
    if (result.blocked) assert.deepEqual(result.codes, ["4F2A9C"]);
  });

  it("blocks a claim that only a hold backs (a hold is not a booking)", () => {
    const result = guard("تم الحجز.", [{ tool: "hold_slot" }]);
    assert.equal(result.blocked, true);
  });

  it("blocks a claim whose confirm_booking failed (no success passed in)", () => {
    const result = guard("تم الحجز.", [{ tool: "confirm_booking", result_ref: "A1B2C3" }]);
    assert.equal(result.blocked, false);
    assert.equal(guard("تم الحجز.", []).blocked, true);
  });
});

describe("guardConfirmation — English declarative claims", () => {
  it("blocks 'is booked'", () => {
    const result = guard("Your appointment is booked for Saturday at 5.", [], "en");
    assert.equal(result.blocked, true);
    assert.equal(result.text, CONFIRMATION_REFUSAL.en);
  });

  it("blocks 'has been booked'", () => {
    const result = guard("The appointment has been booked.", [], "en");
    assert.equal(result.blocked, true);
  });

  it("blocks 'booking confirmed'", () => {
    const result = guard("Booking confirmed for Saturday at 5.", [], "en");
    assert.equal(result.blocked, true);
  });

  it("blocks 'cancelled'", () => {
    const result = guard("Your Saturday appointment has been cancelled.", [], "en");
    assert.equal(result.blocked, true);
  });

  it("blocks 'rescheduled'", () => {
    const result = guard("It was rescheduled to Sunday at 4.", [], "en");
    assert.equal(result.blocked, true);
  });
});

describe("guardConfirmation — codes", () => {
  it("blocks an invented code even with no claim phrase", () => {
    const result = guard("كود الحجز ABC123");
    assert.equal(result.blocked, true);
    if (result.blocked) assert.equal(result.pattern, "appointment_ref");
  });

  it("blocks any UUID spoken in the screen", () => {
    const result = guard("رقم العملية 3f2a9b1c-4d5e-4f6a-8b7c-9d0e1f2a3b4c");
    assert.equal(result.blocked, true);
    if (result.blocked) assert.equal(result.pattern, "uuid");
  });

  it("allows a true confirmation with the matching code", () => {
    const result = guard("تم الحجز. كود التأكيد A1B2C3", BOOKED);
    assert.equal(result.blocked, false);
    assert.equal(result.text, "تم الحجز. كود التأكيد A1B2C3");
  });

  it("blocks a true confirmation carrying a DIFFERENT code", () => {
    const result = guard("تم الحجز. كود التأكيد ZZ9Y8X", BOOKED);
    assert.equal(result.blocked, true);
    if (result.blocked) assert.deepEqual(result.codes, ["ZZ9Y8X"]);
    assert.equal(result.text, CONFIRMATION_REFUSAL.ar);
  });

  it("drops a choice that repeats the unverified code and keeps the rest", () => {
    const choices: ConfirmationChoice[] = [
      { id: "ref_1", label: "كود A1B2C3", value: "كود التأكيد A1B2C3" },
      { id: "home", label: "رجوع", value: "رجوع" },
    ];
    const result = guardConfirmation({ text: "تم الحجز.", choices, lang: "ar", successes: [] });
    assert.equal(result.blocked, true);
    assert.deepEqual(result.choices.map((choice) => choice.id), ["home"]);
  });

  it("lets a false confirmation with no code keep its choices untouched", () => {
    const choices: ConfirmationChoice[] = [{ id: "home", label: "رجوع", value: "رجوع" }];
    const result = guardConfirmation({ text: "تم الحجز.", choices, lang: "ar", successes: [] });
    assert.equal(result.blocked, true);
    assert.deepEqual(result.choices, choices);
  });
});

describe("guardConfirmation — questions and small talk", () => {
  it("never blocks an Arabic question ending in ؟", () => {
    const result = guard("تحب أحجزلك السبت الساعة 5؟");
    assert.equal(result.blocked, false);
  });

  it("never blocks 'would you like'", () => {
    assert.equal(guard("Would you like me to book Saturday at 5?", [], "en").blocked, false);
  });

  it("never blocks هل without a question mark", () => {
    assert.equal(guard("هل تحب أحجز في فرع المقطم").blocked, false);
  });

  it("never blocks 'shall I'", () => {
    assert.equal(guard("Shall I confirm the Saturday slot?", [], "en").blocked, false);
  });

  it("lets a plain greeting through unchanged", () => {
    const text = "أهلاً بحضرتك في عيادة ديمو لطب الأسنان. تحب تحجز في فرع المقطم ولا المعادي؟";
    const result = guard(text);
    assert.equal(result.blocked, false);
    assert.equal(result.text, text);
  });
});

describe("confirmation-guard helpers", () => {
  it("only treats appointment-ref shapes as codes", () => {
    assert.equal(looksLikeAppointmentRef("ABC123"), true);
    assert.equal(looksLikeAppointmentRef("ABCDFE"), true);
    assert.equal(looksLikeAppointmentRef("SUNDAY"), false);
    assert.equal(looksLikeAppointmentRef("DENTAL"), false);
    assert.equal(looksLikeAppointmentRef("A1B2C"), false);
  });

  it("extracts every code in the text once", () => {
    assert.deepEqual(extractCodes("A1B2C3 و A1B2C3 و SUNDAY"), ["A1B2C3"]);
  });

  it("folds Arabic spelling variants before matching", () => {
    assert.equal(normalizeArabic("تأكيد"), "تاكيد");
    assert.equal(normalizeArabic("إلغاء"), "الغاء");
    assert.equal(normalizeArabic("تمامٌ"), "تمام");
    assert.equal(guard("تم تأكيد الحجز").blocked, true);
    assert.equal(guard("تم تاكيد الحجز").blocked, true);
  });
});
