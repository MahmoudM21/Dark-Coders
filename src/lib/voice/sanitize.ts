/**
 * Spoken-text sanitisation for the clinic bridge.
 *
 * `screen.text` and every choice label/value are read aloud, so a stray emoji, a
 * markdown marker or a ZWJ sequence is noise the caller hears as a glitch (and the
 * console's JSON contract rejects some of it anyway). The bridge runs this over
 * those three strings BEFORE schema validation, so a screen that is only emoji
 * sanitises to "" and fails validation like any other malformed reply — which sends
 * it down the repair path instead of being spoken.
 *
 * What it removes: pictographs, regional indicators (flags), skin-tone modifiers,
 * variation selectors, ZWJ, keycaps and other emoji combining marks; markdown links
 * (their text survives), inline code backticks, bold/underline markers and leading
 * heading or "- "/"* " list markers.
 * What it must not touch: Arabic letters and their diacritics, Arabic punctuation,
 * digits, the colon in a time like 4:30, and plain numbers such as 123.
 */

/**
 * Emoji and their combining marks:
 *   \p{Extended_Pictographic}  every pictograph, including ✅ ⚠ 🦷
 *   \p{Regional_Indicator}     the two half-letters that form a flag
 *   U+1F3FB..U+1F3FF           skin-tone modifiers
 *   U+20E3                     the enclosing keycap
 *   U+FE00..U+FE0F, U+E0100+   variation selectors
 *   U+200D                     zero-width joiner (glues sequences together)
 */
const EMOJI =
  /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}\u{20E3}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{200D}]/gu;

/** `![alt](url)` / `[text](url)` keep their text; `<https://…>` keeps the URL. */
function stripLinks(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1");
}

/**
 * Turns a string into something safe to speak. Pure and total: it always returns a
 * string, and an input that is nothing but emoji or markdown returns "".
 */
export function sanitizeSpoken(text: string): string {
  return stripLinks(text)
    .replace(/`{1,3}/g, "") // inline code and code fences
    .replace(/\*\*/g, "") // bold
    .replace(/__/g, "") // bold / underline
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "") // "# heading"
    .replace(/^[ \t]*[-*+][ \t]+/gm, "") // "- item" / "* item" / "+ item"
    .replace(EMOJI, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Applies {@link sanitizeSpoken} to `screen.text`, `screen.choices[].label` and
 * `.value` on a parsed reply, leaving every other field exactly as it was, so the
 * caller can still validate the same object shape afterwards.
 */
export function sanitizeScreenPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const root = { ...(payload as Record<string, unknown>) };
  const screen = root["screen"];
  if (!screen || typeof screen !== "object" || Array.isArray(screen)) return root;
  const inner = { ...(screen as Record<string, unknown>) };

  if (typeof inner["text"] === "string") inner["text"] = sanitizeSpoken(inner["text"]);

  const choices = inner["choices"];
  if (Array.isArray(choices)) {
    inner["choices"] = choices.map((choice) => {
      if (!choice || typeof choice !== "object" || Array.isArray(choice)) return choice;
      const copy = { ...(choice as Record<string, unknown>) };
      if (typeof copy["label"] === "string") copy["label"] = sanitizeSpoken(copy["label"]);
      if (typeof copy["value"] === "string") copy["value"] = sanitizeSpoken(copy["value"]);
      return copy;
    });
  }

  root["screen"] = inner;
  return root;
}
