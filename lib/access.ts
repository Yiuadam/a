"use client";

/*
  The learner's proof of purchase, on this device.

  It sits beside the profile in localStorage and is deliberately not part of it:
  the profile is study history worth exporting and importing between devices,
  this is a credential that should not travel in a JSON file. Same storage,
  separate key, separate lifetime.

  As with `lib/store.ts` this is exposed as an external store so components can
  read it through `useSyncExternalStore` and stay consistent between the server
  render and the client one.
*/

const KEY = "bandup-access-v1";

export interface Access {
  token: string;
  /** Epoch ms the server said this token runs out — a hint for refresh only. */
  expiresAt: number;
}

let cache: Access | null | undefined;
const listeners = new Set<() => void>();

function read(): Access | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Access>;
    if (typeof parsed?.token !== "string" || !parsed.token) return null;
    return { token: parsed.token, expiresAt: Number(parsed.expiresAt) || 0 };
  } catch {
    return null;
  }
}

function commit(next: Access | null): void {
  cache = next;
  if (typeof window !== "undefined") {
    try {
      if (next) window.localStorage.setItem(KEY, JSON.stringify(next));
      else window.localStorage.removeItem(KEY);
    } catch {
      // Private mode or a full quota — keep the in-memory copy for this visit.
    }
  }
  for (const l of listeners) l();
}

export function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** Stable snapshot — the same object identity until something changes. */
export function getSnapshot(): Access | null {
  if (cache === undefined) cache = read();
  return cache;
}

export function getServerSnapshot(): Access | null {
  return null;
}

export function saveAccess(token: string, expiresInSeconds: number): void {
  commit({ token, expiresAt: Date.now() + expiresInSeconds * 1000 });
}

export function clearAccess(): void {
  commit(null);
}

export function accessToken(): string | null {
  return getSnapshot()?.token ?? null;
}

/**
 * Whether to show the app as unlocked.
 *
 * An expired token still counts: the server renews it on the next call, and
 * hiding the paid features in the meantime would flicker the interface for
 * every subscriber every twelve hours.
 */
export function hasAccess(): boolean {
  return Boolean(getSnapshot());
}
