import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeScreenPayload, sanitizeSpoken } from "./sanitize.ts";

describe("sanitizeSpoken", () => {
  it("removes pictographs and their modifiers wherever they appear", () => {
    assert.equal(sanitizeSpoken("تمام 😊"), "تمام");
    assert.equal(sanitizeSpoken("Done ✅"), "Done");
    assert.equal(sanitizeSpoken("شكراً 👍🏽"), "شكراً");
    assert.equal(sanitizeSpoken("🦷"), "");
  });

  it("removes flags, keycaps and ZWJ sequences", () => {
    assert.equal(sanitizeSpoken("🇪🇬 فرع المعادي"), "فرع المعادي");
    assert.equal(sanitizeSpoken("1️⃣"), "1");
    assert.equal(sanitizeSpoken("👨‍👩‍👧 family"), "family");
    assert.equal(sanitizeSpoken("😊 ✅ 👍🏽 🇪🇬 1️⃣"), "1");
  });

  it("strips markdown that would be read aloud", () => {
    assert.equal(sanitizeSpoken("**bold** text"), "bold text");
    assert.equal(sanitizeSpoken("`code` here"), "code here");
    assert.equal(sanitizeSpoken("```json\n{}\n```"), "json {}");
    assert.equal(sanitizeSpoken("# title"), "title");
    assert.equal(sanitizeSpoken("- one\n- two"), "one two");
    assert.equal(sanitizeSpoken("* item"), "item");
    assert.equal(sanitizeSpoken("__underlined__"), "underlined");
  });

  it("keeps a markdown link's text and drops its URL", () => {
    assert.equal(
      sanitizeSpoken("عايز أحجز [اضغط هنا](https://x.invalid/book) بكرة"),
      "عايز أحجز اضغط هنا بكرة",
    );
    assert.equal(sanitizeSpoken("[Booking](https://x.invalid/a/b)"), "Booking");
    assert.equal(sanitizeSpoken("See <https://example.com>"), "See https://example.com");
  });

  it("leaves Arabic letters, tashkeel, punctuation, digits and times alone", () => {
    assert.equal(sanitizeSpoken("أَهْلًا وسَهْلًا"), "أَهْلًا وسَهْلًا");
    assert.equal(sanitizeSpoken("الساعة 4:30"), "الساعة 4:30");
    assert.equal(sanitizeSpoken("123"), "123");
    assert.equal(sanitizeSpoken("تمام، الميعاد الساعة 4:30 م."), "تمام، الميعاد الساعة 4:30 م.");
    assert.equal(sanitizeSpoken("Dr. Yousef El-Refaie"), "Dr. Yousef El-Refaie");
    assert.equal(sanitizeSpoken("رياضيات: 2 + 2 = 4"), "رياضيات: 2 + 2 = 4");
  });

  it("collapses whitespace and trims", () => {
    assert.equal(sanitizeSpoken("  a   b \n\n c  "), "a b c");
  });

  it("returns an empty string when nothing speakable is left", () => {
    // The bridge validates `text` with min(1) afterwards, so "" fails the screen
    // schema and takes the repair path instead of being spoken.
    assert.equal(sanitizeSpoken("😊 ✅"), "");
    assert.equal(sanitizeSpoken("# "), "");
    assert.equal(sanitizeSpoken("   "), "");
  });
});

describe("sanitizeScreenPayload", () => {
  const payload = {
    kind: "screen",
    screen: {
      text: "👋 أهلاً ⚠️",
      choices: [{ id: "slot_1", label: "السبت ✅", value: "احجز **السبت** الساعة 4" }],
      navigation: [],
    },
    action_proposal: null,
    app_commands: [],
  };

  it("sanitises text, labels and values and leaves the rest of the object byte-identical", () => {
    const clean = sanitizeScreenPayload(payload) as typeof payload;
    assert.equal(clean.screen.text, "أهلاً");
    assert.equal(clean.screen.choices[0]?.label, "السبت");
    assert.equal(clean.screen.choices[0]?.value, "احجز السبت الساعة 4");
    assert.equal(clean.screen.choices[0]?.id, "slot_1");
    assert.deepEqual(clean.screen.navigation, []);
    assert.equal(clean.action_proposal, null);
    assert.deepEqual(clean.app_commands, []);
    assert.deepEqual(Object.keys(clean.screen).sort(), ["choices", "navigation", "text"]);
    assert.deepEqual(Object.keys(clean.screen.choices[0]!).sort(), ["id", "label", "value"]);
  });

  it("does not mutate the input object", () => {
    const before = JSON.stringify(payload);
    sanitizeScreenPayload(payload);
    assert.equal(JSON.stringify(payload), before);
  });

  it("passes malformed payloads through untouched for the schema to reject", () => {
    assert.equal(sanitizeScreenPayload(null), null);
    assert.equal(sanitizeScreenPayload("text"), "text");
    assert.deepEqual(sanitizeScreenPayload({ kind: "screen" }), { kind: "screen" });
    assert.deepEqual(sanitizeScreenPayload({ screen: { text: 42, choices: "no" } }), {
      screen: { text: 42, choices: "no" },
    });
  });
});
