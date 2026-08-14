"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import {
  GLASS_PERFORMANCE_QUERY,
  supportsDetailedGlass,
} from "@/lib/glass-performance";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const REDUCED_TRANSPARENCY_QUERY = "(prefers-reduced-transparency: reduce)";

type NetworkNavigator = Navigator & {
  connection?: { saveData?: boolean; addEventListener?: typeof addEventListener; removeEventListener?: typeof removeEventListener };
  deviceMemory?: number;
};

const listeners = new Set<() => void>();
let disposeSharedListeners: (() => void) | null = null;
let cachedSnapshot = false;

function readEligibility() {
  const network = navigator as NetworkNavigator;
  return supportsDetailedGlass({
    finePointer: window.matchMedia(GLASS_PERFORMANCE_QUERY).matches,
    reducedMotion: window.matchMedia(REDUCED_MOTION_QUERY).matches,
    reducedTransparency: window.matchMedia(REDUCED_TRANSPARENCY_QUERY).matches,
    saveData: Boolean(network.connection?.saveData),
    memoryGb: Number.isFinite(network.deviceMemory) ? network.deviceMemory ?? null : null,
    cores: Number.isFinite(navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : null,
  });
}

function notify() {
  cachedSnapshot = readEligibility();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!disposeSharedListeners) {
    const queries = [
      window.matchMedia(GLASS_PERFORMANCE_QUERY),
      window.matchMedia(REDUCED_MOTION_QUERY),
      window.matchMedia(REDUCED_TRANSPARENCY_QUERY),
    ];
    const connection = (navigator as NetworkNavigator).connection;
    cachedSnapshot = readEligibility();
    for (const query of queries) query.addEventListener("change", notify);
    connection?.addEventListener?.("change", notify);
    disposeSharedListeners = () => {
      for (const query of queries) query.removeEventListener("change", notify);
      connection?.removeEventListener?.("change", notify);
      disposeSharedListeners = null;
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) disposeSharedListeners?.();
  };
}

function getSnapshot() {
  return cachedSnapshot;
}

function getServerSnapshot() {
  return false;
}

/**
 * One shared capability store for every SVG lens. On phones, reduced-motion /
 * reduced-transparency setups, Save-Data, and known low-tier hardware, the
 * expensive third-party SVG tree is never mounted—not merely hidden with CSS.
 */
export default function GlassPerformanceGate({ children }: { children: ReactNode }) {
  const enabled = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return enabled ? children : null;
}
