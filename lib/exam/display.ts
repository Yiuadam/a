/*
  The two display settings the real exam offers, and where they are kept.

  Computer-delivered IELTS puts a Settings button in the top-right corner of
  every screen, and behind it are exactly two things a candidate can change:
  how big the text is, and what colour it is on what. Those are not decoration.
  A three-hour exam read at the wrong size is a three-hour headache, and the
  reversed schemes exist because some people cannot read dark-on-light at all.

  So they are reproduced rather than approximated, and they live here — outside
  React — for the same reason the theme does: a value read from localStorage
  inside an effect paints the default for one frame first, and a flash of the
  wrong text size on every page load is worse than no setting at all.

  This is a preference about a screen, not anything a learner did. It goes in
  localStorage beside the theme, and survives closing the tab; the rule that
  wipes practice data on close (lib/progress/storage.ts) is about work, and a
  font size is not work.
*/

export type ExamTextSize = "s" | "m" | "l" | "xl";
export type ExamScheme = "standard" | "reverse";

export interface ExamDisplay {
  size: ExamTextSize;
  scheme: ExamScheme;
}

export const TEXT_SIZES: { id: ExamTextSize; label: string; px: number }[] = [
  { id: "s", label: "Small", px: 15 },
  { id: "m", label: "Standard", px: 17 },
  { id: "l", label: "Large", px: 20 },
  { id: "xl", label: "Extra large", px: 24 },
];

/* Keep the useful accessibility alternative without the yellow-on-black mode. */
export const SCHEMES: { id: ExamScheme; label: string; hint: string }[] = [
  { id: "standard", label: "Follow BandUp", hint: "Warm, light or dark with the site" },
  { id: "reverse", label: "White on black", hint: "For low light or glare" },
];

export const DISPLAY_KEY = "bandup.exam.display";

export const DEFAULT_DISPLAY: ExamDisplay = { size: "m", scheme: "standard" };

function isSize(v: unknown): v is ExamTextSize {
  return v === "s" || v === "m" || v === "l" || v === "xl";
}

function isScheme(v: unknown): v is ExamScheme {
  return v === "standard" || v === "reverse";
}

/* Same external-store shape as lib/theme.ts: read once, cache, notify. */
let cached: ExamDisplay | null = null;
const listeners = new Set<() => void>();

export function subscribeDisplay(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDisplay(): ExamDisplay {
  if (cached) return cached;
  if (typeof window === "undefined") return DEFAULT_DISPLAY;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(DISPLAY_KEY);
  } catch {
    // Private browsing can throw on access; the default is fine.
  }
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const source = (parsed ?? {}) as Partial<ExamDisplay>;
  cached = {
    size: isSize(source.size) ? source.size : DEFAULT_DISPLAY.size,
    scheme: isScheme(source.scheme) ? source.scheme : DEFAULT_DISPLAY.scheme,
  };
  return cached;
}

/** SSR and hydration both use the default, so the first paint matches. */
export function getServerDisplay(): ExamDisplay {
  return DEFAULT_DISPLAY;
}

export function setDisplay(next: Partial<ExamDisplay>): void {
  cached = { ...getDisplay(), ...next };
  try {
    window.localStorage.setItem(DISPLAY_KEY, JSON.stringify(cached));
  } catch {
    // Nothing to do: the setting still applies for this session.
  }
  for (const listener of listeners) listener();
}

/** The pixel size for a setting, for anything that needs the number. */
export function sizeInPx(size: ExamTextSize): number {
  return TEXT_SIZES.find((s) => s.id === size)?.px ?? 17;
}
