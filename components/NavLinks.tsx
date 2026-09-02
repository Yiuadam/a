"use client";

import Link from "next/link";
import { useRoutePath } from "@/lib/hooks";

/*
  The header had no sense of place: seven destinations and nothing saying which
  one you were on. The active link gets a filled pill and the strongest text
  colour.

  Deliberately no weight change on the active item — the nav is a horizontal
  scroller on a phone, and switching a label from medium to semibold changes its
  width, which shifts every link beside it on navigation.
*/
export default function NavLinks({
  items,
}: {
  items: readonly { href: string; label: string }[];
}) {
  /* The prefix test below survives the iOS export's trailing slash on its own
     and "/" is the one route the slash cannot change, so nothing here was
     broken. It reads the route the same way as every other component anyway,
     because a file left reading the raw pathname is the one somebody copies
     next. See routePath in lib/platform.ts. */
  const pathname = useRoutePath();

  return (
    <nav className="nav-scroll no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm">
      {items.map((item) => {
        // "/" must match exactly, or every page would light up Home.
        const active =
          item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 whitespace-nowrap rounded-xl px-3 py-2 transition-colors ${
              active
                ? "bg-indigo-50 text-indigo-700"
                : "text-slate-600 hover:bg-surface hover:text-slate-900"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
