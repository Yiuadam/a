import type { Route } from "next";

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
    ],
  },
  {
    title: "Study",
    items: [
      { href: "/", label: "Home" },
      { href: "/plan", label: "My plan" },
      { href: "/history", label: "History" },
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
      /*
        One row, not two.

        It was "Usage and plan" and "Plans and pricing" sitting next to each
        other, and they read as the same destination twice — the owner's word
        was "confusing", and it is hard to argue: both contain "plan", and
        nothing in either label says which one has your bill in it.

        So the menu offers the page a learner has a reason to open — what they
        have spent and what they are paying — and /pricing is reached from
        inside it, where "Compare plans" sits next to the plan you are already
        on. That is the right order anyway: you look at your bill often and at
        the price list once.

        /pricing is still a real page with its own URL. It is simply not a
        thing to go browsing for from a menu.
      */
      { href: "/billing", label: "Bill and usage" },
      /* Read once, if ever — so it lives in the menu and not the header row. */
      { href: "/credits", label: "Credits" },
    ],
  },
];

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
