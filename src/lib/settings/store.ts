import { useCallback, useSyncExternalStore } from "react";

const listeners = new Map<string, Set<() => void>>();
const cache = new Map<string, { raw: string | null; value: unknown }>();

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.value as T;
  let value: T = fallback;
  if (raw) {
    try { value = { ...(fallback as object), ...JSON.parse(raw) } as T; } catch { value = fallback; }
  }
  cache.set(key, { raw, value });
  return value;
}

export function readLocal<T>(key: string, fallback: T): T {
  return read(key, fallback);
}

const writeHooks = new Set<(key: string, value: unknown) => void>();
/** Observe every local write (used by cloud sync). */
export function onLocalWrite(fn: (key: string, value: unknown) => void) {
  writeHooks.add(fn);
  return () => { writeHooks.delete(fn); };
}

export function writeLocal<T>(key: string, value: T, opts?: { silent?: boolean }) {
  window.localStorage.setItem(key, JSON.stringify(value));
  listeners.get(key)?.forEach((fn) => fn());
  if (!opts?.silent) writeHooks.forEach((fn) => fn(key, value));
}

/** Browser-saved settings shared live across components. Server render uses the fallback. */
export function useLocal<T extends object>(key: string, fallback: T): [T, (next: T | ((prev: T) => T)) => void] {
  const subscribe = useCallback((fn: () => void) => {
    const set = listeners.get(key) ?? new Set();
    set.add(fn);
    listeners.set(key, set);
    return () => set.delete(fn);
  }, [key]);
  const value = useSyncExternalStore(subscribe, () => read(key, fallback), () => fallback);
  const update = useCallback((next: T | ((prev: T) => T)) => {
    const prev = read(key, fallback);
    writeLocal(key, typeof next === "function" ? (next as (p: T) => T)(prev) : next);
  }, [key, fallback]);
  return [value, update];
}
