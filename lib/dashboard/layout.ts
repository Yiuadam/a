"use client";

/*
  Which modules the dashboard shows, and in what order.

  A per-device preference, not account data, and stored the way the theme is
  stored (lib/theme.ts) for exactly that reason: it describes how this person
  likes to look at the page on this screen, it is worthless on a server, and
  losing it costs a learner nothing but a drag. localStorage rather than the
  progress store keeps it out of sync, out of the export, and out of the
  account-deletion path, where it would otherwise be one more thing that has to
  be right.

  The stored value is a list of ids. Order is position on the board and
  membership is visibility, so "hidden" is simply absence — there is no second
  flag that can disagree with the list it sits beside.

  Unknown ids are dropped on read and known-but-absent ids are never added
  back. That combination is what lets a module be renamed, removed or added in
  a later version without a migration: an id this build does not recognise is
  forgotten, and a new module stays off the board until it is chosen, which is
  the polite default for something the learner has already arranged.
*/

export const DASHBOARD_LAYOUT_KEY = "bandup.dashboard.modules";

/** Every module the board can draw, in the order the library lists them. */
export const MODULE_LIBRARY = [
  {
    id: "score",
    /* One word under the preview in the library — see ModuleLibrary. */
    short: "Band",
    group: "Progress",
    name: "Your band",
    blurb: "The overall band and the four skills that make it, each linking to its history.",
  },
  {
    id: "plan",
    /* One word under the preview in the library — see ModuleLibrary. */
    short: "Plan",
    group: "Study",
    name: "What to do next",
    blurb: "The first two blocks of your study plan, with a way into the rest.",
  },
  {
    id: "tutor",
    /* One word under the preview in the library — see ModuleLibrary. */
    short: "Tutor",
    group: "Help",
    name: "Ask a tutor",
    blurb: "Three openers only a tutor that has read your own work can answer.",
  },
  {
    id: "recent",
    /* One word under the preview in the library — see ModuleLibrary. */
    short: "Recent",
    group: "Progress",
    name: "Recent practice",
    blurb: "Your last six sittings and the band each one earned.",
  },
  {
    id: "practise",
    /* One word under the preview in the library — see ModuleLibrary. */
    short: "Skills",
    group: "Study",
    name: "Practise a skill",
    blurb: "The four exam skills as tiles, for going straight to a paper.",
  },
  {
    id: "study",
    /* One word under the preview in the library — see ModuleLibrary. */
    short: "Study",
    group: "Study",
    name: "Study the language",
    blurb: "Grammar and vocabulary drills, with no clock and no band.",
  },
  {
    id: "streak",
    short: "Streak",
    group: "Progress",
    name: "Your streak",
    blurb: "Consecutive days with at least one sitting.",
  },
  {
    id: "week",
    short: "Week",
    group: "Progress",
    name: "This week",
    blurb: "How many papers you have sat in the last seven days.",
  },
  {
    id: "weakest",
    short: "Weakest",
    group: "Progress",
    name: "Weakest skill",
    blurb: "Your lowest band, and a way straight to it.",
  },
  {
    id: "strongest",
    short: "Strongest",
    group: "Progress",
    name: "Strongest skill",
    blurb: "Your highest band, and the trend behind it.",
  },
  {
    id: "target",
    short: "Target",
    group: "Progress",
    name: "To your target",
    blurb: "How far your overall band is from the one you are aiming at.",
  },
  {
    id: "sittings",
    short: "Sat",
    group: "Progress",
    name: "Papers sat",
    blurb: "Every marked sitting on this account.",
  },
  {
    id: "last",
    short: "Last",
    group: "Progress",
    name: "Last sitting",
    blurb: "The band you most recently earned, and the paper it came from.",
  },
  {
    id: "mock",
    short: "Mock",
    group: "Study",
    name: "Full mock exam",
    blurb: "All four skills on the real clock, marked only at the end.",
  },
  {
    id: "papersLeft",
    short: "Left",
    group: "Study",
    name: "Papers left",
    blurb: "Reading and listening papers you have not sat yet.",
  },
] as const;

export type ModuleId = (typeof MODULE_LIBRARY)[number]["id"];
export type ModuleGroup = (typeof MODULE_LIBRARY)[number]["group"];

/** The filters the library offers, in the order it lists them. */
export const MODULE_GROUPS = ["Progress", "Study", "Help"] as const;

const KNOWN = new Set<string>(MODULE_LIBRARY.map((m) => m.id));

/*
  Four modules, two by two, which is what fits one screen without scrolling —
  the thing the owner asked for. Everything else starts in the library.

  The free-Pro offer is deliberately not among them and is not a module at all.
  It is a first-time notice: it is answered once, with "Sign up free" or "No
  thanks", and an answered notice that can be put back on a board is a notice
  that asks again. It sits above the board instead, where FreeProPoster's own
  rule about when to draw itself is the only thing deciding whether it appears.
*/
export const DEFAULT_LAYOUT: ModuleId[] = ["score", "plan", "tutor", "recent"];

/*
  How many modules the board holds, which is a consequence rather than a taste.

  The dashboard does not scroll — that is the point of it — so the board can
  only carry what one screen shows. Two columns of two is what fits at every
  width the rail appears at, down to an iPad in landscape, and a fifth module
  would either push the fourth off the bottom or force every card shorter to
  make room. Adding is refused at the cap rather than silently making room,
  because a board that quietly drops what you had chosen to fit what you just
  chose is worse than one that says it is full.
*/
export const MAX_MODULES = 4;

/** Whether another module can be placed without breaking the one-screen rule. */
export function boardIsFull(ids: readonly string[]): boolean {
  return ids.length >= MAX_MODULES;
}

function parse(raw: string | null): ModuleId[] | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    const ids = value
      .filter((id): id is ModuleId => typeof id === "string" && KNOWN.has(id))
      .slice(0, MAX_MODULES);
    // A stored list that survives with nothing in it is a board with nothing on
    // it, which reads as broken rather than as empty on purpose.
    return ids.length > 0 ? [...new Set(ids)] : null;
  } catch {
    return null;
  }
}

let cache: ModuleId[] | null = null;
const listeners = new Set<() => void>();

export function getLayout(): ModuleId[] {
  if (cache) return cache;
  if (typeof window === "undefined") return DEFAULT_LAYOUT;
  cache = parse(window.localStorage.getItem(DASHBOARD_LAYOUT_KEY)) ?? DEFAULT_LAYOUT;
  return cache;
}

/* The server renders the default, always, so the markup is stable. */
export function getServerLayout(): ModuleId[] {
  return DEFAULT_LAYOUT;
}

export function subscribeLayout(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setLayout(next: readonly ModuleId[]): void {
  /*
    Trimmed to the cap on the way in, so a stored list from an older build — or
    a hand-edited one — cannot put five modules on a page that shows four.
  */
  const ids = [...new Set(next.filter((id) => KNOWN.has(id)))].slice(0, MAX_MODULES);
  cache = ids.length > 0 ? ids : DEFAULT_LAYOUT;
  try {
    window.localStorage.setItem(DASHBOARD_LAYOUT_KEY, JSON.stringify(cache));
  } catch {
    /* A private window, or storage the browser has refused. The board still
       works for this visit; it simply will not remember. */
  }
  for (const listener of listeners) listener();
}

/** Move one module to another's position, keeping everything else in order. */
export function reorder(ids: readonly ModuleId[], from: ModuleId, to: ModuleId): ModuleId[] {
  if (from === to) return [...ids];
  const next = ids.filter((id) => id !== from);
  const at = next.indexOf(to);
  if (at === -1) return [...ids];
  /*
    Dropped *onto* a card, so the dragged one takes that card's place and the
    rest shuffle along. Inserting before the target is what makes a drag to the
    right feel like a swap rather than an off-by-one — the target moves out of
    the way in the direction the pointer came from.
  */
  const before = ids.indexOf(from) < ids.indexOf(to) ? at + 1 : at;
  next.splice(before, 0, from);
  return next;
}
