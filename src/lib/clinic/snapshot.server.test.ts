import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLINIC_INFO_TTL_MS,
  createTtlCache,
  formatAvailabilitySnapshot,
  parseAvailabilitySnapshot,
  snapshotNeedsRefresh,
  type AvailabilitySnapshot,
} from "./snapshot.server.ts";

/** A prefetch envelope shaped exactly like clinic_prefetch_availability's jsonb. */
function prefetchEnvelope(
  overrides: { generatedAtMs?: number; branches?: unknown[]; ok?: boolean } = {},
) {
  const generatedAtMs = overrides.generatedAtMs ?? Date.parse("2026-10-16T19:25:36Z");
  return {
    ok: overrides.ok ?? true,
    data: {
      selected_branch_ref: null,
      visit_type: "dental_visit",
      visit_minutes: 30,
      window_days: 2,
      limit: 5,
      generated_at: new Date(generatedAtMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
      generated_local: { iso_date: "2026-10-16", time_24: "22:25", weekday_en: "Friday" },
      valid_for_seconds: 60,
      branches: overrides.branches ?? [
        {
          branch_ref: "maadi",
          branch_name: "Maadi Branch",
          branch_name_ar: "فرع المعادي",
          timezone: "Africa/Cairo",
          slots: [
            {
              doctor_ref: "dr-yousef-el-refaie",
              doctor_name_en: "Dr. Yousef El-Refaie",
              doctor_name_ar: "د. يوسف الرفاعي",
              starts_at: "2026-10-17T13:00:00Z",
              local: {
                time_24: "16:00",
                iso_date: "2026-10-17",
                spoken_ar: "السبت 17 أكتوبر الساعة 4 مساءً",
                spoken_en: "Saturday October 17 at 4:00 PM",
              },
            },
          ],
        },
        {
          branch_ref: "mokattam",
          branch_name: "Mokattam Branch",
          branch_name_ar: "فرع المقطم",
          timezone: "Africa/Cairo",
          slots: [
            {
              doctor_ref: "dr-mohamed-ali",
              doctor_name_en: "Dr. Mohamed Ali",
              doctor_name_ar: "د. محمد علي",
              starts_at: "2026-10-17T13:30:00Z",
              local: {
                time_24: "16:30",
                iso_date: "2026-10-17",
                spoken_ar: "السبت 17 أكتوبر الساعة 4:30 مساءً",
                spoken_en: "Saturday October 17 at 4:30 PM",
              },
            },
          ],
        },
      ],
    },
  };
}

describe("ttl cache", () => {
  it("serves a value until the ttl elapses and then forgets it", () => {
    let now = 1_000;
    const cache = createTtlCache<string>({ ttlMs: 5_000, now: () => now });
    assert.equal(cache.get("a"), null);
    cache.set("a", "payload");
    assert.equal(cache.get("a"), "payload");
    now += 4_999;
    assert.equal(cache.get("a"), "payload");
    now += 1;
    assert.equal(cache.get("a"), null);
    assert.equal(cache.size(), 0);
  });

  it("expires entries with different write times independently and can be cleared", () => {
    let now = 0;
    const cache = createTtlCache<number>({ ttlMs: 1_000, now: () => now });
    cache.set("old", 1);
    now += 900;
    cache.set("new", 2);
    now += 200; // "old" is 1100ms old, "new" only 200ms
    assert.equal(cache.get("old"), null);
    assert.equal(cache.get("new"), 2);
    cache.delete("new");
    assert.equal(cache.get("new"), null);
  });

  it("exposes the documented clinic-info ttl of five minutes", () => {
    assert.equal(CLINIC_INFO_TTL_MS, 300_000);
  });
});

describe("snapshot freshness", () => {
  const base: AvailabilitySnapshot = {
    text: "x",
    generatedAtMs: 1_000,
    validForSeconds: 60,
    branchRef: null,
  };

  it("refreshes when there is no snapshot at all", () => {
    assert.equal(snapshotNeedsRefresh(null, 1_000), true);
  });

  it("reuses a snapshot inside its own validity window and refreshes past it", () => {
    assert.equal(snapshotNeedsRefresh(base, 1_000), false);
    assert.equal(snapshotNeedsRefresh(base, 60_999), false);
    assert.equal(snapshotNeedsRefresh(base, 61_000), true);
  });

  it("honours a shorter valid_for_seconds from the database", () => {
    const short = { ...base, validForSeconds: 10 };
    assert.equal(snapshotNeedsRefresh(short, 10_999), false);
    assert.equal(snapshotNeedsRefresh(short, 11_000), true);
  });
});

describe("parseAvailabilitySnapshot", () => {
  const now = Date.parse("2026-10-16T19:25:40Z");

  it("accepts a fresh envelope and keeps the branch state it saw", () => {
    const parsed = parseAvailabilitySnapshot(prefetchEnvelope(), now);
    assert.ok(parsed);
    assert.equal(parsed.validForSeconds, 60);
    assert.equal(parsed.branchRef, null);
    assert.equal(parsed.generatedAtMs, Date.parse("2026-10-16T19:25:36Z"));
    assert.match(
      parsed.text,
      /^AVAILABILITY SNAPSHOT generated at 2026-10-16 22:25 Friday \(advisory; hold_slot is authoritative\):/,
    );
  });

  it("records a selected branch when the session already has one", () => {
    const envelope = prefetchEnvelope();
    (envelope.data as Record<string, unknown>)["selected_branch_ref"] = "maadi";
    const parsed = parseAvailabilitySnapshot(envelope, now);
    assert.ok(parsed);
    assert.equal(parsed.branchRef, "maadi");
  });

  it("refuses a stale envelope instead of injecting it", () => {
    const old = prefetchEnvelope({ generatedAtMs: Date.parse("2026-10-16T19:24:30Z") });
    assert.equal(parseAvailabilitySnapshot(old, now), null);
  });

  it("refuses error envelopes and malformed payloads", () => {
    assert.equal(parseAvailabilitySnapshot({ ok: false, error: { code: "DB_ERROR" } }, now), null);
    assert.equal(parseAvailabilitySnapshot(null, now), null);
    assert.equal(parseAvailabilitySnapshot({ ok: true, data: { branches: [] } }, now), null);
    assert.equal(parseAvailabilitySnapshot(prefetchEnvelope({ branches: [] }), now), null);
    const noStamp = prefetchEnvelope();
    delete (noStamp.data as Record<string, unknown>)["generated_at"];
    assert.equal(parseAvailabilitySnapshot(noStamp, now), null);
    const badStamp = prefetchEnvelope();
    (badStamp.data as Record<string, unknown>)["generated_at"] = "yesterday";
    assert.equal(parseAvailabilitySnapshot(badStamp, now), null);
  });

  it("refuses an envelope whose branches carry no usable slots", () => {
    const empty = prefetchEnvelope({ branches: [{ branch_ref: "maadi", slots: [] }] });
    assert.equal(parseAvailabilitySnapshot(empty, now), null);
  });

  it("falls back to a 60s window when valid_for_seconds is missing", () => {
    const envelope = prefetchEnvelope();
    delete (envelope.data as Record<string, unknown>)["valid_for_seconds"];
    const parsed = parseAvailabilitySnapshot(envelope, now);
    assert.ok(parsed);
    assert.equal(parsed.validForSeconds, 60);
    assert.equal(parseAvailabilitySnapshot(envelope, now + 61_000), null);
  });
});

describe("formatAvailabilitySnapshot", () => {
  it("lists both branches in the order given, with ISO, local clock, spoken Arabic and doctor_ref", () => {
    const text = formatAvailabilitySnapshot(prefetchEnvelope().data as Record<string, unknown>);
    assert.ok(text);
    const maadi = text.indexOf("maadi (فرع المعادي) — doctor_ref dr-yousef-el-refaie");
    const mokattam = text.indexOf("mokattam (فرع المقطم) — doctor_ref dr-mohamed-ali");
    assert.ok(maadi >= 0 && mokattam > maadi, "both branches present, in payload order");
    assert.match(
      text,
      /starts_at 2026-10-17T13:00:00Z \(16:00 local\) — السبت 17 أكتوبر الساعة 4 مساءً — doctor_ref dr-yousef-el-refaie/,
    );
    assert.match(text, /Only a successful hold_slot reserves a slot/);
  });

  it("returns null when there is nothing truthful to say", () => {
    assert.equal(formatAvailabilitySnapshot({}), null);
    assert.equal(formatAvailabilitySnapshot({ branches: [{ branch_ref: "maadi" }] }), null);
  });
});
