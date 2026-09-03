"use client";

import Link from "next/link";
import CardIcon from "@/components/CardIcon";
import { Icon } from "@/components/Icons";
import { useRoutePath } from "@/lib/hooks";
import { NAV_ICONS, RAIL_GROUPS, SKILL_ICONS, currentHref } from "@/lib/nav";

/*
  The navigation, standing open, on a screen with room for it.

  BandUp's nav has always been complete and always been hidden: NAV_GROUPS holds
  every destination, grouped by what a learner is doing, and all of it lived
  behind one menu button at every width up to a 32-inch display. The reason was
  sound at the time — a header that lists everything stops being a header, and
  the previous one needed 706px in the 578px it had. But that is an argument
  about a horizontal strip, and it was being applied to screens with five
  hundred pixels of empty paper down each side.

  So navigation in the space that was already empty — but the short list, not
  the whole menu. Eighteen rows standing open is something to search rather
  than a set of places to go, so the rail draws RAIL_GROUPS: the four skills,
  where you stand, what to do next, and the tutor. Everything else is still one
  tap away behind the menu button, which is unchanged. See lib/nav.ts for what
  was left out and why.

  ---------------------------------------------------------------------------
  Why 64rem and not a pixel width

  The rail appears from `lg` up — 1024px at the default root, which is every
  iPad in landscape and every laptop — and it is deliberately not offered below
  that. On a phone it would be the whole screen, and on an iPad in portrait it
  would take a quarter of the width from the thing the learner came to read.
  Below `lg` the menu button is still there and still holds everything, exactly
  as before.

  Written in rem so it grows with the root on a large display like the rest of
  the product does now (see the clamp on html in app/globals.css). A rail fixed
  in pixels beside type that scales gets proportionally thinner as the screen
  gets bigger, which is the opposite of what a bigger screen is for.

  16rem, and 18rem past xl — widened at the owner's ask. The first version was
  sized to the longest label with nothing spare, which reads as a list squeezed
  against the edge of the window rather than as a column the page is laid out
  around. The page beside it loses nothing: it was not short of width at these
  sizes, which was the whole reason the rail could exist.
*/

export default function SideRail() {
  const pathname = useRoutePath();
  const here = currentHref(pathname);
  const groups = RAIL_GROUPS;

  return (
    /*
      The rail does not move, at the owner's ask: on a page long enough to
      scroll, the page scrolls and the navigation stays where it is.

      `sticky` with a zero-distance top does that without `fixed`. It began as
      sticky-below-the-header, which meant the rail travelled upward with the
      page until its top met the header and only then stopped — a first
      scroll that moved the one thing on screen that should be a fixed point.
      Pinned from the start, it never moves at all.

      `self-start` is what lets a sticky element work inside a flex row: without
      it the item stretches to the row's height and has nothing left to stick
      within.

      It does not scroll, at the owner's ask, and that is a decision with a
      cost worth naming: on a window shorter than the rail the last group is
      simply not reachable. It is an acceptable cost here because the rail is
      twelve rows and the shortest window this appears in is an iPad in
      landscape at 768 tall, where twelve rows fit with room to spare — and
      because the menu button still holds every destination for the window that
      does not. A rail with its own scrollbar is two scrollbars on one screen,
      and the owner is right that it reads as a mistake.
    */
    <nav
      aria-label="Sections"
      className="side-rail sticky top-[var(--header-h)] hidden h-fit w-64 shrink-0 self-start overflow-hidden lg:block xl:w-72"
    >
      <div className="space-y-5 pb-6 pl-1 pr-2 pt-3">
        {groups.map((group) => (
          <div key={group.title}>
            <h2 className="mb-1.5 px-3 text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-500">
              {group.title}
            </h2>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = here === item.href;
                const icon = NAV_ICONS[item.href];
                const skill = SKILL_ICONS[item.href];
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      prefetch={false}
                      aria-current={active ? "page" : undefined}
                      /*
                        The active row is a filled pill rather than a coloured
                        label. At a glance the question is "where am I", and a
                        shape answers that from further away than a hue does —
                        which also means it still answers it for somebody who
                        cannot separate the two colours.
                      */
                      className={`side-rail-item flex min-h-10 items-center gap-3 rounded-full px-3 py-1.5 text-[0.9375rem] font-medium transition-colors ${
                        active
                          ? "side-rail-item-active text-slate-900"
                          : "text-slate-600 hover:text-slate-900"
                      }`}
                    >
                      {/*
                        Heavier than the 1.3 these glyphs were drawn with,
                        because the rail draws them at 17px and not at the 24
                        they were chosen at. A stroke is a fraction of the
                        viewBox, so it shrinks with the mark: at this size 1.3
                        lands under a physical pixel and the icon goes fainter
                        than the word beside it, which does not get lighter as
                        it gets smaller. 1.75 is 1.3 scaled back up by the same
                        ratio, near enough.
                      */}
                      {skill ? (
                        <Icon
                          name={skill}
                          strokeWidth={1.75}
                          className="h-[1.0625rem] w-[1.0625rem] shrink-0 text-indigo-600"
                        />
                      ) : icon ? (
                        <CardIcon name={icon} size={17} strokeWidth={1.75} />
                      ) : null}
                      <span className="min-w-0 truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
