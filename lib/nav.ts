import type { Route } from "next";
import { IS_MOBILE_BUILD } from "./platform";

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
  let best: string | null = null;
  for (const group of NAV_GROUPS) {
    for (const { href } of group.items) {
      const hit = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
      if (!hit) continue;
      if (best === null || href.length > best.length) best = href;
    }
  }
  return best;
}
