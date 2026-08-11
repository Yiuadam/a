/*
  The two charts an owner keeps on the admin overview.

  This is deliberately separate from the component that draws the chooser:
  persisted browser data is untrusted input, and the validation is useful to
  test without mounting React or pretending Node has a browser DOM.
*/

export const ADMIN_OVERVIEW_STORAGE_KEY = "bandup.admin.overview.v1";
export const ADMIN_OVERVIEW_EVENT = "bandup:admin-overview-change";

export const ADMIN_OVERVIEW_CHART_IDS = [
  "signups",
  "usage",
  "net-receipts",
  "contribution",
] as const;

export type AdminOverviewChartId = (typeof ADMIN_OVERVIEW_CHART_IDS)[number];
export type AdminOverviewSlot = AdminOverviewChartId | "none";

export interface AdminOverviewPreference {
  version: 1;
  slots: [AdminOverviewSlot, AdminOverviewSlot];
}

const KNOWN_CHARTS = new Set<string>(ADMIN_OVERVIEW_CHART_IDS);

export function isAdminOverviewChartId(value: unknown): value is AdminOverviewChartId {
  return typeof value === "string" && KNOWN_CHARTS.has(value);
}

export function defaultAdminOverviewPreference(
  available: readonly AdminOverviewChartId[] = ADMIN_OVERVIEW_CHART_IDS,
): AdminOverviewPreference {
  const unique = [...new Set(available.filter(isAdminOverviewChartId))];
  const first = unique.includes("signups") ? "signups" : (unique[0] ?? "none");
  const second = unique.includes("usage")
    ? "usage"
    : (unique.find((id) => id !== first) ?? "none");
  return { version: 1, slots: [first, second] };
}

/**
 * Read a saved preference only when every field still makes sense for the
 * registry rendered by this build. Unknown future/old chart ids, wrong
 * versions and duplicate charts all fall back together; accepting half of a
 * corrupted layout makes the controls disagree with the cards underneath.
 * `none` may appear twice because it is an empty slot, not a duplicated chart.
 */
export function parseAdminOverviewPreference(
  raw: string | null,
  available: readonly AdminOverviewChartId[] = ADMIN_OVERVIEW_CHART_IDS,
): AdminOverviewPreference {
  const fallback = defaultAdminOverviewPreference(available);
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return fallback;

    const candidate = parsed as { version?: unknown; slots?: unknown };
    if (candidate.version !== 1 || !Array.isArray(candidate.slots) || candidate.slots.length !== 2) {
      return fallback;
    }

    const allowed = new Set(available.filter(isAdminOverviewChartId));
    const slots = candidate.slots as unknown[];
    if (
      !slots.every((slot) => slot === "none" || (isAdminOverviewChartId(slot) && allowed.has(slot)))
    ) {
      return fallback;
    }
    if (slots[0] !== "none" && slots[0] === slots[1]) return fallback;

    return {
      version: 1,
      slots: slots as [AdminOverviewSlot, AdminOverviewSlot],
    };
  } catch {
    return fallback;
  }
}

export function serializeAdminOverviewPreference(preference: AdminOverviewPreference): string {
  return JSON.stringify({ version: 1, slots: preference.slots });
}

/** Browser-only store adapter used with useSyncExternalStore. */
export function readAdminOverviewSnapshot(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(ADMIN_OVERVIEW_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function subscribeToAdminOverview(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;

  const onStorage = (event: StorageEvent) => {
    if (event.key === ADMIN_OVERVIEW_STORAGE_KEY) onChange();
  };
  const onSameTab = () => onChange();
  window.addEventListener("storage", onStorage);
  window.addEventListener(ADMIN_OVERVIEW_EVENT, onSameTab);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(ADMIN_OVERVIEW_EVENT, onSameTab);
  };
}

function announceAdminOverviewChange(): void {
  window.dispatchEvent(new Event(ADMIN_OVERVIEW_EVENT));
}

export function writeAdminOverviewPreference(preference: AdminOverviewPreference): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(
      ADMIN_OVERVIEW_STORAGE_KEY,
      serializeAdminOverviewPreference(preference),
    );
    announceAdminOverviewChange();
    return true;
  } catch {
    return false;
  }
}

export function resetAdminOverviewPreference(): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.removeItem(ADMIN_OVERVIEW_STORAGE_KEY);
    announceAdminOverviewChange();
    return true;
  } catch {
    return false;
  }
}
