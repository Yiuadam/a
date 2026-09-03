import type { Route } from "next";
import type { CardIconName } from "@/components/CardIcon";
import { IS_MOBILE_BUILD, routePath } from "./platform";

/*
  Where the app can go, in one place.

  Two lists, and the split between them is the whole point.

  PRIMARY is what sits in the header: the four exam skills and the plan that
  sends a learner to them. Five words. It is short because a header that lists
  everything stops being a header — the previous one carried nine destinations,
  needed 706px to draw them, had 578px, and painted its last two over the
  account button at every width including a 1440px monitor. Widening the header
  bought room for one more destination, which is not a fix, only a delay.

  NAV_GROUPS is everything, including the five above, and it lives behind the
  menu button. Nothing is reachable only from the header, so the header is free
  to be short.

  The grouping is by what a learner is doing, not by what the code is: Practise
  is "give me something to do", Study is "tell me how I am doing and what to
  learn", Help is "explain something to me". Home sits in Study because that is
  where the dashboard's own summary belongs.

  Typed as Route because next/link is typed-routes-aware; a path that does not
  exist fails the build here rather than 404ing for a learner.
*/

export interface NavItem {
  href: Route;
  label: string;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

/** The header row. Five destinations, and it must stay five — see above. */
export const PRIMARY: NavItem[] = [
  { href: "/plan", label: "My plan" },
  { href: "/practice/listening", label: "Listening" },
  { href: "/practice/reading", label: "Reading" },
  { href: "/practice/writing", label: "Writing" },
  { href: "/speaking", label: "Speaking" },
];

/** Everything, grouped, behind the menu button. */
export const NAV_GROUPS: NavGroup[] = [
  {
    title: "Practise",
    items: [
      { href: "/practice/listening", label: "Listening" },
      { href: "/practice/reading", label: "Reading" },
      { href: "/practice/writing", label: "Writing" },
      { href: "/speaking", label: "Speaking" },
      { href: "/practice", label: "All practice tests" },
      /*
        Last in the group, and deliberately not in PRIMARY.

        A mock exam is not the thing to do on a Tuesday evening — it is nearly
        three hours and it tells you nothing until the end. Putting it in the
        header would offer it as a fifth way to practise, and most learners who
        took it up on that would be spending an evening measuring instead of
        learning. It belongs where somebody goes looking for it.
      */
      { href: "/exam", label: "Full mock exam" },
    ],
  },
  {
    title: "Study",
    items: [
      { href: "/", label: "Home" },
      { href: "/plan", label: "My plan" },
      { href: "/history", label: "History" },
      { href: "/organization", label: "Organisation" },
      { href: "/grammar", label: "Grammar" },
      { href: "/vocabulary", label: "Vocabulary" },
    ],
  },
  {
    title: "Help",
    items: [
      { href: "/chat", label: "Ask a tutor" },
      { href: "/resources", label: "Guides" },
      { href: "/account", label: "Your account" },
      /* Buying and checking usage are two different intentions, so each gets a
         direct, plainly named destination. Both are absent from the iOS build,
         where Apple requires subscriptions to use In-App Purchase. */
      ...(IS_MOBILE_BUILD
        ? []
        : [
            { href: "/pricing", label: "Plans & pricing" } as const,
            { href: "/billing", label: "Usage & billing" } as const,
          ]),
      /* Read once, if ever — so it lives in the menu and not the header row. */
      { href: "/about", label: "About BandUp" },

    ],
  },
];

/**
 * The owner's own screen, added to the menu only for the owner.
 *
 * Kept out of NAV_GROUPS rather than filtered out of it, because a row that
 * every learner can see and nobody but the owner can open is a menu item that
 * answers "page not found" — confusing for them and no protection at all for
 * it. Hiding a link is not access control and this does not pretend to be:
 * /admin and the route behind it both answer 404 to anyone who is not the
 * owner, whether or not they ever saw a link.
 */
export const OWNER_ITEM: NavItem = { href: "/admin", label: "Site settings" };

/**
 * Which destination a path is "on", or null.
 *
 * The most specific match wins. A plain prefix test marks two rows at once —
 * on /practice/reading both "Reading" and "All practice tests" match, because
 * /practice is a prefix of /practice/reading — so every match is collected and
 * the longest kept. "/" is special-cased: it prefixes everything, and matching
 * it everywhere would mark Home on every page.
 */
export function currentHref(pathname: string): string | null {
  /*
    The hrefs above are written without a trailing slash and the iOS export's
    pathname arrives with one, so the two forms are reconciled here rather than
    left to the prefix arm below, which does happen to catch a slashed path but
    catches it as a child of itself. See routePath in lib/platform.ts.
  */
  const path = routePath(pathname);
  let best: string | null = null;
  for (const group of NAV_GROUPS) {
    for (const { href } of group.items) {
      const hit = href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
      if (!hit) continue;
      if (best === null || href.length > best.length) best = href;
    }
  }
  return best;
}

/*
  Whether a route shows the standing navigation rail.

  Two components need the same answer and must not disagree about it:
  AppMain draws the rail, and SiteHeader hides its own row of primary links
  when the rail is there, because the two would otherwise name the same five
  destinations twice on the same screen.

  The routes excluded are the ones that own the whole window — the console and
  the organisation workspace draw their own chrome, and the exam, the tutor and
  a practice paper are locked to one viewport so a rail beside them would be
  taking width from the thing being read. See components/AppMain.tsx.
*/
export function hasSideRail(pathname: string): boolean {
  const path = routePath(pathname);
  if (path.startsWith("/admin") || path.startsWith("/organization")) return false;
  return !(
    path === "/chat" ||
    path === "/practice/listening" ||
    path === "/practice/reading" ||
    path === "/practice/writing" ||
    path === "/exam"
  );
}


/*
  Which glyph each destination carries, in two families.

  Here rather than in the component that draws them, and that is not tidiness.
  The tables are keyed by href, so wherever they live is a file that names
  every route in the app — including /pricing and /billing, which the iOS build
  must not offer. Keeping them beside the lists that already gate those routes
  means the gate and the names it hides are one file apart rather than two, and
  a component that reads from here cannot reintroduce a route this file has
  removed.

  Two families because they are different shapes at different weights and
  neither stands in for the other: the four exam skills and the two drill
  sections are drawn from the homepage set, everything else from the card set.
*/
export const SKILL_ICONS: Partial<Record<string, string>> = {
  "/practice/listening": "listening",
  "/practice/reading": "reading",
  "/practice/writing": "writing",
  "/speaking": "speaking",
  "/grammar": "grammar",
  "/vocabulary": "vocabulary",
};

export const NAV_ICONS: Partial<Record<string, CardIconName>> = {
  "/": "home",
  "/plan": "plan",
  "/history": "history",
  "/organization": "organization",
  "/practice": "practice",
  "/exam": "mock",
  "/chat": "tutor",
  "/resources": "guides",
  "/about": "about",
  "/account": "profile",
  "/admin": "settings",
  "/settings": "gear",
  ...(!IS_MOBILE_BUILD ? { "/pricing": "plans" as const, "/billing": "usage" as const } : {}),
};

/*
  The short list the standing rail draws, which is not the whole menu.

  NAV_GROUPS is everything and stays everything — nothing is being taken away,
  and the menu button beside the logo still opens all of it. But a rail is read
  by scanning it, and eighteen rows is a list to search rather than a set of
  places to go. What is here is what a learner opens on an ordinary evening:
  the four skills, where they stand, what to do next, and the tutor.

  What is deliberately not here: the practice index and the mock exam (reached
  from the skills themselves, and a three-hour sitting is not an ordinary
  evening), the organisation workspace, guides, account, plans, billing, about,
  and the owner console. Each is one tap away in the menu, which is where you go
  when you are looking for something rather than doing something.
*/
export const RAIL_GROUPS: NavGroup[] = [
  {
    title: "Practise",
    items: [
      { href: "/practice/listening", label: "Listening" },
      { href: "/practice/reading", label: "Reading" },
      { href: "/practice/writing", label: "Writing" },
      { href: "/speaking", label: "Speaking" },
    ],
  },
  {
    title: "Study",
    items: [
      { href: "/", label: "Home" },
      { href: "/plan", label: "My plan" },
      { href: "/history", label: "History" },
      /* A teacher's roster is a place they go every day, not a setting. */
      { href: "/organization", label: "Organisation" },
      { href: "/grammar", label: "Grammar" },
      { href: "/vocabulary", label: "Vocabulary" },
    ],
  },
  {
    title: "Help",
    items: [{ href: "/chat", label: "Ask a tutor" }],
  },
  /*
    Account and settings sit at the foot of the rail, apart from the three
    groups above, because they are about the app rather than about studying —
    the same reason the account button has always sat beside the theme toggle
    rather than in the row of destinations. Settings is the door to everything
    the rail leaves out; see RAIL_OVERFLOW.
  */
  {
    title: "You",
    items: [
      { href: "/account", label: "Your account" },
      { href: "/settings", label: "Settings" },
    ],
  },
];

/*
  Everything the rail does not carry, which is what /settings is a page of.

  Derived rather than listed, so the two cannot drift: a destination added to
  NAV_GROUPS and not to RAIL_GROUPS appears on the settings page without anyone
  remembering to put it there, and one promoted to the rail leaves the settings
  page by the same arithmetic.
*/
export const RAIL_OVERFLOW: NavItem[] = NAV_GROUPS.flatMap((group) => group.items).filter(
  (item) =>
    !RAIL_GROUPS.some((group) => group.items.some((railItem) => railItem.href === item.href)),
);
