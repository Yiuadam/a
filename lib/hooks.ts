"use client";

import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { routePath } from "./platform";
import { getServerSnapshot, getSnapshot, subscribe } from "./store";
import type { Profile } from "./types";

/**
 * The current route, in the one form the app compares routes in.
 *
 * Every component asking "am I on /practice/writing" wants this rather than
 * usePathname, because the iOS build's pathname carries a trailing slash the
 * website's does not; routePath in lib/platform.ts holds the whole of the
 * reason. Anything wanting a path to *navigate* to still wants the raw
 * usePathname — see the last paragraph there.
 */
export function useRoutePath(): string {
  return routePath(usePathname());
}

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
