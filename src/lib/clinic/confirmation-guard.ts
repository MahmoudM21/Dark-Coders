/**
 * Deterministic confirmation guard.
 *
 * The measured drift on the primary model was a fluent lie: `تم الحجز. كود التأكيد ABC123`
 * in turns where `confirm_booking` was never called, or returned APPROVAL_PENDING. The
 * screen contract cannot catch that — the JSON was always valid — so the bridge decides it
 * in code, after the reply is validated and before it reaches the caller.
 *
 * Rules, all of them deterministic:
 *   * A declarative claim (Arabic or English phrase lists below) must be backed by a
 *     successful `confirm_booking` / `reschedule_appointment` / `cancel_appointment` audit
 *     row **from this same turn**.
 *   * Every confirmation code in the text must be one of those rows' `result_ref` values,
 *     so an invented code cannot ride along with a real booking.
 *   * Questions are never touched: a receptionist must be able to ask "shall I book it?".
 *
 * A blocked screen is replaced with one fixed, truthful sentence (and any choice that
 * repeats the unverified code is dropped), and the bridge audits the block.
 */

export const BOOKING_TOOLS = ["confirm_booking", "reschedule_appointment", "cancel_appointment"] as const;
export type BookingTool = (typeof BOOKING_TOOLS)[number];

/** One successful booking-tool call from this turn's `audit_events` rows. */
export type ConfirmationSuccess = {
  tool: string;
  /** `appointments.confirmation_code` — 6 uppercase characters, never PII. */
  result_ref?: string;
};

export type ConfirmationChoice = { id: string; label: string; value: string };

export type ConfirmationLang = "ar" | "en";

export type ConfirmationGuardInput = {
  text: string;
  choices: ReadonlyArray<ConfirmationChoice>;
  /** Language of the caller's LAST turn — that is the language this screen answers. */
  lang: ConfirmationLang;
  successes: ReadonlyArray<ConfirmationSuccess>;
};

export type ConfirmationGuardResult = { blocked: false; text: string; choices: ConfirmationChoice[] } | {
  blocked: true;
  /** Pattern that matched, by name only — the raw text is never audited. */
  pattern: string;
  /** Unverified codes found in the text, uppercase. */
  codes: string[];
  text: string;
  choices: ConfirmationChoice[];
};

/** Exactly what the caller hears instead. Verbatim, so the wording cannot drift. */
export const CONFIRMATION_REFUSAL: Record<ConfirmationLang, string> = {
  ar: "لسه ما اتأكدش حاجة. هقولك أول ما الحجز يتأكد.",
  en: "Nothing is confirmed yet. I will tell you as soon as the booking is confirmed.",
};

/** Arabic diacritics, Quranic marks and tatweel, plus the letter forms that vary by typist. */
const ARABIC_NOISE = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

/**
 * Folds Arabic text to one spelling before matching: diacritics and tatweel removed,
 * أإآٱ→ا, ى→ي, ة→ه. Callers and models spell the same word several ways; matching on the
 * folded form is what makes the phrase lists reliable. Exported for the emergency
 * classifier's tests to reuse the same rules.
 */
export function normalizeArabic(input: string): string {
  return input
    .replace(ARABIC_NOISE, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase();
}

/**
 * Declarative claims. Stored folded, so they are written the way {@link normalizeArabic}
 * leaves them ("تم تأكيد" is listed as "تم تاكيد").
 */
const ARABIC_CLAIMS: ReadonlyArray<{ name: string; phrase: string }> = [
  { name: "ar_booked", phrase: "تم الحجز" },
  { name: "ar_confirmed", phrase: "تم تاكيد" },
  { name: "ar_confirmed", phrase: "اتاكد الحجز" },
  { name: "ar_confirmed", phrase: "الحجز اتاكد" },
  { name: "ar_cancelled", phrase: "تم الغاء" },
  { name: "ar_rescheduled", phrase: "تم تعديل" },
  { name: "ar_booked_for_caller", phrase: "حجزت لحضرتك" },
  { name: "ar_ref_code", phrase: "رقم التاكيد" },
  { name: "ar_ref_code", phrase: "كود التاكيد" },
  { name: "ar_ref_code", phrase: "رمز التاكيد" },
];

const ENGLISH_CLAIMS: ReadonlyArray<{ name: string; phrase: string }> = [
  { name: "en_booked", phrase: "is booked" },
  { name: "en_booked", phrase: "has been booked" },
  { name: "en_confirmed", phrase: "booking confirmed" },
  { name: "en_confirmed", phrase: "appointment confirmed" },
  { name: "en_cancelled", phrase: "cancelled" },
  { name: "en_cancelled", phrase: "canceled" },
  { name: "en_rescheduled", phrase: "rescheduled" },
  { name: "en_ref_code", phrase: "confirmation code" },
];

/** A question can never be a false confirmation claim: it is how the caller is asked. */
const QUESTION_MARKERS = ["تحب", "أأكد", "هل"].map(normalizeArabic);
const ENGLISH_QUESTION_MARKERS = ["would you like", "shall i"];
const QUESTION_END = /[?؟]\s*$/;

const REF_TOKEN = /\b[A-Z0-9]{6}\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * `appointments.confirmation_code` is 6 uppercase hex characters (migration §appointments).
 * A token counts as one when it is 6 uppercase alphanumerics AND either carries a digit or
 * is pure A-F, which keeps ordinary words ("SUNDAY", "DENTAL") out of the pattern.
 */
export function looksLikeAppointmentRef(token: string): boolean {
  return /^[A-Z0-9]{6}$/.test(token) && (/[0-9]/.test(token) || /^[A-F]{6}$/.test(token));
}

function isQuestion(text: string, folded: string): boolean {
  if (QUESTION_END.test(text)) return true;
  if (QUESTION_MARKERS.some((marker) => folded.includes(marker))) return true;
  const lower = text.toLowerCase();
  return ENGLISH_QUESTION_MARKERS.some((marker) => lower.includes(marker));
}

/** Every confirmation code the text utters: appointment-ref-shaped tokens and any UUID. */
export function extractCodes(text: string): string[] {
  const codes = new Set<string>();
  for (const match of text.matchAll(REF_TOKEN)) {
    if (looksLikeAppointmentRef(match[0])) codes.add(match[0]);
  }
  for (const match of text.matchAll(UUID)) codes.add(match[0].toUpperCase());
  return [...codes];
}

function matchedClaim(text: string, lang: ConfirmationLang): string | null {
  const folded = normalizeArabic(text);
  const lower = text.toLowerCase();
  if (lang === "ar") {
    for (const claim of ARABIC_CLAIMS) if (folded.includes(claim.phrase)) return claim.name;
    for (const claim of ENGLISH_CLAIMS) if (lower.includes(claim.phrase)) return claim.name;
    return null;
  }
  for (const claim of ENGLISH_CLAIMS) if (lower.includes(claim.phrase)) return claim.name;
  for (const claim of ARABIC_CLAIMS) if (folded.includes(claim.phrase)) return claim.name;
  return null;
}

/**
 * Decides whether this screen may be spoken, and returns the screen to speak: the original
 * one when the claim is backed by this turn's own successful call, or the fixed truthful
 * sentence with the offending choices dropped when it is not.
 *
 * Navigation and any server-attached `action_proposal` are the caller's concern, not this
 * function's: it only rewrites `text` and `choices`.
 */
export function guardConfirmation(input: ConfirmationGuardInput): ConfirmationGuardResult {
  const text = input.text;
  const folded = normalizeArabic(text);

  // A question is a request for consent, not a claim that anything happened.
  if (isQuestion(text, folded)) return { blocked: false, text, choices: [...input.choices] };

  // Codes are read from the text AND the choices: a button label is spoken too, so an
  // invented code must not survive inside one after the sentence was replaced.
  const codes = [
    ...new Set([...extractCodes(text), ...input.choices.flatMap((choice) => [...extractCodes(choice.label), ...extractCodes(choice.value)])]),
  ];
  const claim = matchedClaim(text, input.lang);
  if (!claim && codes.length === 0) return { blocked: false, text, choices: [...input.choices] };

  const successfulTools = input.successes.filter((entry) => (BOOKING_TOOLS as readonly string[]).includes(entry.tool));
  const verified = new Set(
    successfulTools.flatMap((entry) => (entry.result_ref ? [entry.result_ref.toUpperCase()] : [])),
  );
  const everyCodeVerified = codes.every((code) => verified.has(code));

  if (successfulTools.length > 0 && everyCodeVerified) {
    return { blocked: false, text, choices: [...input.choices] };
  }

  const keptChoices = input.choices.filter(
    (choice) => !codes.some((code) => choice.label.toUpperCase().includes(code) || choice.value.toUpperCase().includes(code)),
  );

  return {
    blocked: true,
    pattern: claim ?? (codes.some((code) => code.includes("-")) ? "uuid" : "appointment_ref"),
    codes,
    text: CONFIRMATION_REFUSAL[input.lang],
    choices: keptChoices,
  };
}
