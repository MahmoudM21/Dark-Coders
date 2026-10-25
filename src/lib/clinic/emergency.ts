/**
 * Deterministic emergency screening.
 *
 * The measured drift was urgent pain with no `escalate_to_human` call in 4 of 7 turns: the
 * prompt says "safety first", the model decides otherwise. Waiting for a model to notice a
 * possible emergency is not a safety property, so the bridge classifies the caller's own
 * words before the model is even asked, performs the escalation itself, and tells the model
 * what really happened.
 *
 * Everything here is pure and synchronous: normalise the text, look for a symptom, then
 * discard matches that are negated ("no chest pain") or in the remote past ("years ago").
 * Ordinary dental complaints must never trigger — a toothache is why people call a dentist.
 */

export const EMERGENCY_CATEGORIES = [
  "self_harm",
  "chest_pain",
  "breathing",
  "unconscious",
  "seizure",
  "uncontrolled_bleeding",
  "severe_allergy",
  "airway_swelling",
  "overdose_poisoning",
  "stroke_signs",
] as const;

export type EmergencyCategory = (typeof EMERGENCY_CATEGORIES)[number];

export type EmergencyVerdict = { match: false; category: null } | { match: true; category: EmergencyCategory };

const ARABIC_NOISE = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;
const ARABIC_INDIC = /[\u0660-\u0669\u06F0-\u06F9]/g;

/**
 * Folds Arabic to one spelling for matching: diacritics and tatweel removed, أإآٱ→ا, ى→ي,
 * ة→ه, Arabic-Indic digits → ASCII, lowercased. Only the matched copy is folded; the text
 * itself is never altered, and it is never stored.
 */
export function normalizeForMatch(input: string): string {
  return input
    .replace(ARABIC_NOISE, "")
    .replace(ARABIC_INDIC, (digit) => {
      const code = digit.charCodeAt(0);
      const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
      return String(code - base);
    })
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase();
}

/**
 * Symptom phrases per category, most specific first. Written already folded, so they are
 * compared against {@link normalizeForMatch} output as plain substrings.
 */
const SYMPTOMS: ReadonlyArray<{ category: EmergencyCategory; phrases: readonly string[] }> = [
  {
    category: "self_harm",
    phrases: ["انتحر", "اقتل نفسي", "اؤذي نفسي", "اذي نفسي", "kill myself", "suicide", "end my life", "harm myself"],
  },
  {
    category: "chest_pain",
    phrases: [
      "الم في الصدر",
      "الم شديد في الصدر",
      "وجع في الصدر",
      "صدري بيوجعني",
      "ضغط علي صدري",
      "chest pain",
      "pain in my chest",
      "chest hurts",
      "chest pressure",
    ],
  },
  {
    category: "breathing",
    phrases: [
      "مش قادر اتنفس",
      "مش قادره اتنفس",
      "مش قادرين نتنفس",
      "صعوبه في التنفس",
      "ضيق في النفس",
      "هتخنق",
      "هختنق",
      "مخنوق",
      "can't breathe",
      "cant breathe",
      "cannot breathe",
      "difficulty breathing",
      "short of breath",
      "gasping for air",
    ],
  },
  {
    category: "unconscious",
    phrases: ["اغمي عليه", "اغمى عليه", "فقد الوعي", "مغمي عليه", "غاب عن الوعي", "unconscious", "passed out", "fainted", "unresponsive"],
  },
  {
    category: "seizure",
    phrases: ["تشنجات", "تشنج", "صرع", "seizure", "convulsion", "convulsing", "fitting"],
  },
  {
    category: "uncontrolled_bleeding",
    phrases: [
      "النزيف مش بيقف",
      "النزيف مش بيوقف",
      "نزيف مش بيوقف",
      "نزيف شديد",
      "نزيف غزير",
      "bleeding won't stop",
      "bleeding wont stop",
      "heavy bleeding",
      "bleeding a lot",
      "bleeding heavily",
    ],
  },
  {
    category: "severe_allergy",
    phrases: ["حساسيه شديده", "حساسيه قاتله", "تفاعل تحسسي", "severe allergic", "severe allergy", "anaphyla", "allergic reaction"],
  },
  {
    category: "airway_swelling",
    phrases: [
      "وشه ورم",
      "حلقي بيورم",
      "تورم في الحلق",
      "مش قادر يبلع",
      "مش قادره تبلع",
      "swollen throat",
      "throat swelling",
      "throat closing",
      "can't swallow",
      "cant swallow",
      "airway swelling",
    ],
  },
  {
    category: "overdose_poisoning",
    phrases: ["جرعه زياده", "جرعه زايده", "اخدت جرعه زياده", "تسمم", "overdose", "poison", "poisoning", "took too many pills"],
  },
  {
    category: "stroke_signs",
    phrases: [
      "وشه مايل",
      "فمه مايل",
      "كلام متلخبط",
      "لسانه تقل",
      "face drooping",
      "face is drooping",
      "slurred speech",
      "one side numb",
      "weakness on one side",
    ],
  },
];

/**
 * Negation: the symptom is being denied, not reported. `ما عنديش` is two words, so the
 * Arabic markers are matched against the joined run of words, not word by word.
 */
const ARABIC_NEGATIONS = ["ما عنديش", "ما عندي", "مفيش", "من غير", "لا يوجد", "بدون", "مش"].map(normalizeForMatch);
const ENGLISH_NEGATION = /\b(?:no|not|never|without|denies|denied|don't|dont|didn't|didnt|isn't|isnt|n't)\b/;

/** Remote past: it happened years ago and is not happening now. */
const ARABIC_REMOTE_PAST = ["من سنين", "من سنه", "من زمان", "سنين", "سنه"].map(normalizeForMatch);
const ENGLISH_REMOTE_PAST = /\b(?:last year|years ago|months ago|used to|when i was (?:a )?(?:child|kid))\b/;

/** How many words immediately before the symptom still count as its negation. */
const NEGATION_WINDOW = 3;

/**
 * A contrast marker ends the scope of a negation in front of it: "مفيش ألم في الصدر بس
 * مش قادر اتنفس" is a denial of the first symptom and a report of the second.
 */
const CONTRAST = /(?:^|\s)(?:بس|لكن|انما|but|however)(?=\s|$)/g;

function boundingClause(folded: string, index: number): { clause: string; start: number } {
  const boundary = /[.!?؟،؛;\n]/;
  let start = index;
  while (start > 0 && !boundary.test(folded[start - 1] ?? " ")) start -= 1;
  let end = index;
  while (end < folded.length && !boundary.test(folded[end] ?? " ")) end += 1;
  return { clause: folded.slice(start, end), start };
}

function isDeniedOrHistorical(folded: string, index: number): boolean {
  const { clause, start } = boundingClause(folded, index);

  // Only the part of the clause after the last contrast marker can still negate this symptom.
  let segmentStart = 0;
  for (const marker of clause.matchAll(CONTRAST)) {
    const end = (marker.index ?? 0) + marker[0].length;
    if (end <= index - start) segmentStart = end;
    else break;
  }
  const segment = clause.slice(segmentStart);
  const offset = index - start - segmentStart;

  if (ENGLISH_REMOTE_PAST.test(segment)) return true;
  if (ARABIC_REMOTE_PAST.some((marker) => segment.includes(marker))) return true;

  const words = segment.slice(0, Math.max(0, offset)).split(/\s+/).filter(Boolean);
  const before = words.slice(-NEGATION_WINDOW).join(" ");
  const head = words.slice(0, NEGATION_WINDOW).join(" ");
  return [before, head].some((run) => run.length > 0 && isNegation(run));
}

function isNegation(run: string): boolean {
  if (ENGLISH_NEGATION.test(run)) return true;
  return ARABIC_NEGATIONS.some((marker) => run.includes(marker));
}

/**
 * Classifies one utterance. Returns the first category whose symptom phrase appears in a
 * clause that neither denies it nor places it in the remote past.
 */
export function classifyEmergency(text: string): EmergencyVerdict {
  const folded = normalizeForMatch(text);
  if (!folded.trim()) return { match: false, category: null };

  for (const { category, phrases } of SYMPTOMS) {
    for (const phrase of phrases) {
      const index = folded.indexOf(phrase);
      if (index < 0) continue;
      if (isDeniedOrHistorical(folded, index)) continue;
      return { match: true, category };
    }
  }
  return { match: false, category: null };
}

/**
 * At most `limit` characters of the caller's own words with every run of digits masked, for
 * the escalation summary. No name, no phone and no code survives digit masking.
 */
export function emergencySummary(text: string, limit = 200): string {
  return text
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}
