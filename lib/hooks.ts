"use client";

import { useSyncExternalStore } from "react";
import { getServerSnapshot, getSnapshot, subscribe } from "./store";
import type { Profile } from "./types";

/** The saved profile, kept in sync across every component that reads it. */
export function useProfile(): Profile {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

const neverChanges = () => () => {};

/**
 * False during server render and the hydration pass, true afterwards. Use it to
 * gate anything that depends on browser-only APIs.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(
    neverChanges,
    () => true,
    () => false,
  );
}
