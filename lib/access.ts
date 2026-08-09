"use client";

import type { Meter, PlanId } from "./plans";

/*
  The learner's plan, on this device.

  It sits beside the profile in localStorage and is deliberately not part of it:
  the profile is study history worth exporting between devices, this is a
  credential that should not travel in a JSON file. Same storage, separate key,
  separate lifetime.

  The usage figures cached here are a display convenience only — the server
  keeps the authoritative counters, because a number the client can edit is a
  number the client can reset. Nothing is gated on what is stored here.

  As with `lib/store.ts` this is exposed as an external store so components can
  read it through `useSyncExternalStore` and stay consistent between the server
  render and the client one.
*/

const KEY = "bandup-access-v2";

export interface Usage {
  used: number;
  limit: number;
  remaining: number;
}

export interface Access {
  token: string;
  /** Epoch ms the server said this token runs out — a hint for refresh only. */
  expiresAt: number;
  plan?: PlanId;
  planName?: string;
  /** Last figures the server reported. Display only. */
  usage?: Partial<Record<Meter, Usage>>;
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
    return {
      token: parsed.token,
      expiresAt: Number(parsed.expiresAt) || 0,
      plan: parsed.plan,
      planName: parsed.planName,
      usage: parsed.usage,
    };
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

export interface AccessPayload {
  token: string;
  expiresIn: number;
  plan?: PlanId;
  planName?: string;
  usage?: Partial<Record<Meter, Usage>>;
}

export function saveAccess(payload: AccessPayload): void {
  commit({
    token: payload.token,
    expiresAt: Date.now() + payload.expiresIn * 1000,
    plan: payload.plan,
    planName: payload.planName,
    usage: payload.usage,
  });
}

/** Record what the server last said was left, without touching the token. */
export function noteUsage(meter: Meter, usage: Usage): void {
  const current = getSnapshot();
  if (!current) return;
  commit({ ...current, usage: { ...current.usage, [meter]: usage } });
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
