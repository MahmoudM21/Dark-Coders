/**
 * Latency helpers for the clinic bridge (`/api/agent`).
 *
 * The bridge used to pay a `clinic_get_info` round trip on every turn and to wait
 * for the availability prefetch before starting the model call. This module holds
 * the decision logic for the two caches that remove that cost, plus the one
 * function that turns a prefetch envelope into model context.
 *
 * Nothing here touches the database or the network: every decision takes an
 * explicit `now`, so the unit tests can move the clock, and no function invents
 * data. If it cannot prove a value is fresh it returns `null` and the caller
 * falls back to the real tool call.
 */

export type JsonObject = Record<string, unknown>;

export type CacheEntry<T> = { at: number; value: T };

export type TtlCache<T> = {
  get: (key: string) => T | null;
  set: (key: string, value: T) => void;
  delete: (key: string) => void;
  size: () => number;
};

/** Tiny TTL cache. `now` is injectable so tests can move the clock. */
export function createTtlCache<T>(options: { ttlMs: number; now?: () => number }): TtlCache<T> {
  const clock = options.now ?? Date.now;
  const entries = new Map<string, CacheEntry<T>>();
  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return null;
      if (clock() - hit.at >= options.ttlMs) {
        entries.delete(key);
        return null;
      }
      return hit.value;
    },
    set(key, value) {
      entries.set(key, { at: clock(), value });
    },
    delete(key) {
      entries.delete(key);
    },
    size: () => entries.size,
  };
}

export type AvailabilitySnapshot = {
  /** The data-only system message injected into the model context. */
  text: string;
  /** The database's own `generated_at` (epoch ms) — the age reference. */
  generatedAtMs: number;
  validForSeconds: number;
  /** The branch the session had selected when the snapshot was taken, or null. */
  branchRef: string | null;
};

/** Cache bound only. Freshness is decided per snapshot from its own validity window. */
export const SNAPSHOT_CACHE_BOUND_MS = 10 * 60_000;
/** How long a `clinic_get_info` payload may serve later turns of the same tenant/branch. */
export const CLINIC_INFO_TTL_MS = 5 * 60_000;

/** True when there is no usable snapshot, or the one we have is past its own validity window. */
export function snapshotNeedsRefresh(entry: AvailabilitySnapshot | null, nowMs: number): boolean {
  if (!entry) return true;
  return nowMs - entry.generatedAtMs >= entry.validForSeconds * 1000;
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Builds the injected snapshot text from a prefetch payload.
 * Returns null when there is nothing truthful to say (no branches, no slots).
 */
export function formatAvailabilitySnapshot(data: JsonObject): string | null {
  const branches = data["branches"];
  if (!Array.isArray(branches)) return null;

  const generated = asObject(data["generated_local"]);
  const stamp = generated
    ? [
        asString(generated["iso_date"]),
        asString(generated["time_24"]),
        asString(generated["weekday_en"]),
      ]
        .filter((part): part is string => part !== null)
        .join(" ")
    : null;

  const lines: string[] = [];
  for (const rawBranch of branches) {
    const branch = asObject(rawBranch);
    if (!branch) continue;
    const ref = asString(branch["branch_ref"]);
    if (!ref) continue;
    const name = asString(branch["branch_name_ar"]) ?? asString(branch["branch_name"]) ?? ref;
    const tz = asString(branch["timezone"]) ?? "local";

    const slotLines: string[] = [];
    let doctor: string | null = null;
    const slots = branch["slots"];
    if (Array.isArray(slots)) {
      for (const rawSlot of slots) {
        const slot = asObject(rawSlot);
        if (!slot) continue;
        const startsAt = asString(slot["starts_at"]);
        if (!startsAt) continue;
        const local = asObject(slot["local"]);
        const clock = local ? asString(local["time_24"]) : null;
        const spoken = local
          ? (asString(local["spoken_ar"]) ?? asString(local["spoken_en"]))
          : null;
        const doctorRef = asString(slot["doctor_ref"]);
        if (doctorRef) doctor = doctor ?? doctorRef;
        slotLines.push(
          `  - starts_at ${startsAt}${clock ? ` (${clock} local)` : ""}${spoken ? ` — ${spoken}` : ""}${
            doctorRef ? ` — doctor_ref ${doctorRef}` : ""
          }`,
        );
      }
    }
    if (!slotLines.length) continue;
    lines.push(`${ref} (${name})${doctor ? ` — doctor_ref ${doctor}` : ""} · ${tz}`);
    lines.push(...slotLines);
  }

  if (!lines.length) return null;

  return [
    `AVAILABILITY SNAPSHOT generated at ${stamp ?? "an unknown local time"} (advisory; hold_slot is authoritative):`,
    ...lines,
    "Only a successful hold_slot reserves a slot; a branch still has to be chosen with select_branch before holding.",
  ].join("\n");
}

/**
 * Turns a `clinic_prefetch_availability` envelope into a snapshot, or null.
 *
 * Null is returned — never a partial or invented message — when the envelope is
 * an error, is missing fields, or is already past its validity window, so a
 * stale snapshot can never reach the model.
 */
export function parseAvailabilitySnapshot(
  envelope: unknown,
  nowMs: number,
): AvailabilitySnapshot | null {
  const root = asObject(envelope);
  if (!root || root["ok"] !== true) return null;
  const data = asObject(root["data"]);
  if (!data) return null;

  const branches = data["branches"];
  if (!Array.isArray(branches) || branches.length === 0) return null;

  const generatedAt = asString(data["generated_at"]);
  if (!generatedAt) return null;
  const generatedAtMs = Date.parse(generatedAt);
  if (Number.isNaN(generatedAtMs)) return null;

  const documented = data["valid_for_seconds"];
  const validForSeconds = typeof documented === "number" && documented > 0 ? documented : 60;
  if (nowMs - generatedAtMs >= validForSeconds * 1000) return null;

  const text = formatAvailabilitySnapshot(data);
  if (!text) return null;

  return { text, generatedAtMs, validForSeconds, branchRef: asString(data["selected_branch_ref"]) };
}

/** Process-local caches. One isolate keeps them; memory is bounded by the TTLs. */
export const clinicInfoCache = createTtlCache<JsonObject>({ ttlMs: CLINIC_INFO_TTL_MS });
export const snapshotCache = createTtlCache<AvailabilitySnapshot>({
  ttlMs: SNAPSHOT_CACHE_BOUND_MS,
});
