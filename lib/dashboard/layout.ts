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
    id: "highlight",
    group: "Progress",
    name: "What is new",
    blurb: "The offer, your placement summary, or your organisation — whichever applies.",
  },
  {
    id: "score",
    group: "Progress",
    name: "Your band",
    blurb: "The overall band and the four skills that make it, each linking to its history.",
  },
  {
    id: "plan",
    group: "Study",
    name: "What to do next",
    blurb: "The first two blocks of your study plan, with a way into the rest.",
  },
  {
    id: "tutor",
    group: "Help",
    name: "Ask a tutor",
    blurb: "Three openers only a tutor that has read your own work can answer.",
  },
  {
    id: "recent",
    group: "Progress",
    name: "Recent practice",
    blurb: "Your last six sittings and the band each one earned.",
  },
  {
    id: "practise",
    group: "Study",
    name: "Practise a skill",
    blurb: "The four exam skills as tiles, for going straight to a paper.",
  },
  {
    id: "study",
    group: "Study",
    name: "Study the language",
    blurb: "Grammar and vocabulary drills, with no clock and no band.",
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
*/
export const DEFAULT_LAYOUT: ModuleId[] = ["highlight", "score", "tutor", "plan"];

function parse(raw: string | null): ModuleId[] | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    const ids = value.filter((id): id is ModuleId => typeof id === "string" && KNOWN.has(id));
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
  const ids = [...new Set(next.filter((id) => KNOWN.has(id)))];
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
