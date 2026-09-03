"use client";

import Link from "next/link";
import CardIcon from "@/components/CardIcon";
import { Icon } from "@/components/Icons";
import { useRoutePath } from "@/lib/hooks";
import { NAV_GROUPS, NAV_ICONS, OWNER_ITEM, SKILL_ICONS, currentHref } from "@/lib/nav";
import { useTier } from "@/lib/billing/useTier";

/*
  The navigation, standing open, on a screen with room for it.

  BandUp's nav has always been complete and always been hidden: NAV_GROUPS holds
  every destination, grouped by what a learner is doing, and all of it lived
  behind one menu button at every width up to a 32-inch display. The reason was
  sound at the time — a header that lists everything stops being a header, and
  the previous one needed 706px in the 578px it had. But that is an argument
  about a horizontal strip, and it was being applied to screens with five
  hundred pixels of empty paper down each side.

  So the same list, in the space that was already empty. Nothing new to
  maintain: this reads NAV_GROUPS, the menu reads NAV_GROUPS, and a destination
  added to that file appears in both.

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
*/

export default function SideRail() {
  const pathname = useRoutePath();
  const account = useTier();
  const isOwner = account.phase === "ready" && account.signedIn && account.tier === "admin";
  const groups = isOwner
    ? NAV_GROUPS.map((group, i) =>
        i === NAV_GROUPS.length - 1 ? { ...group, items: [...group.items, OWNER_ITEM] } : group,
      )
    : NAV_GROUPS;
  const here = currentHref(pathname);

  return (
    /*
      `sticky` rather than `fixed`: the rail scrolls with the page until its top
      reaches the header and then stays, which keeps it out of the way of the
      footer instead of floating over it. `self-start` is what lets a sticky
      element work inside a flex row — without it the item stretches to the row's
      height and has nothing to stick within.
    */
    <nav
      aria-label="Sections"
      className="side-rail sticky top-[calc(var(--header-h)+0.75rem)] hidden h-fit w-56 shrink-0 self-start lg:block xl:w-60"
    >
      <div className="space-y-5 pb-6 pl-1 pr-2">
        {groups.map((group) => (
          <div key={group.title}>
            <h2 className="mb-1.5 px-2.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-500">
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
                      className={`side-rail-item flex min-h-9 items-center gap-2.5 rounded-full px-2.5 py-1.5 text-[0.875rem] font-medium transition-colors ${
                        active
                          ? "side-rail-item-active text-slate-900"
                          : "text-slate-600 hover:text-slate-900"
                      }`}
                    >
                      {skill ? (
                        <Icon name={skill} className="h-[1.0625rem] w-[1.0625rem] shrink-0 text-indigo-600" />
                      ) : icon ? (
                        <CardIcon name={icon} size={17} />
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
