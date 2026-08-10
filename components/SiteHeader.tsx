"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "@/components/ThemeToggle";
import { NAV_GROUPS, OWNER_ITEM, PRIMARY, currentHref } from "@/lib/nav";
import { useTier } from "@/lib/billing/useTier";

/*
  The whole header, in one client component.

  It is one component rather than a row in the layout plus a separate menu
  because the two share a single piece of state: when the menu is open the row
  hides. A learner looking at the expanded list should not also be looking at
  five of the same words in the bar above it. Splitting them would mean lifting
  `open` into a context and threading it through a server component, which is
  a lot of plumbing to answer "are these two things the same thing" — they are.

  What the header shows: the four exam skills and the plan that sends a learner
  to them. Five words. It is short because the previous one was not: nine
  destinations needed 706px, the header had 578px, and the last two were
  painted over the account button at every width up to and including a 1440px
  monitor. Everything else lives behind the menu button, at every width, so the
  row never has to grow again. See lib/nav.ts.

  Behaviour of the menu, all of it the ordinary expected kind:

    Escape closes it, and focus goes back to the button that opened it.
    A tap outside closes it.
    Following a link closes it — including a link to the page you are already
      on, where the route never changes and nothing would otherwise happen.
    The page behind it cannot scroll while it is open.
    The current page is marked, and only ever one row is.

  The panel is rendered only when open. Keeping it mounted and hidden would put
  a second copy of every destination in the accessibility tree and in the tab
  order, competing with the row.
*/

export default function SiteHeader() {
  const pathname = usePathname();

  /*
    The owner sees one row nobody else does. Appended to the last group rather
    than given a heading of its own: a section containing a single item reads
    as a mistake, and the menu is grouped by what a person is doing — settings
    for the site belong beside settings for the account.

    Generous while the answer is unknown is the wrong default here, so it is
    the opposite of the tier gates elsewhere: the row appears only once the
    account is known to be the owner's. Nothing is protected by that, and
    nothing needs to be — /admin answers 404 to everyone else either way.
  */
  /*
    Absent from the console, which draws its own. See components/SiteFooter.tsx
    — the two halves of the site's chrome make the same decision for the same
    reason, and they make it separately because they are separate components.
  */
  const onConsole = pathname.startsWith("/admin");

  const account = useTier();
  const isOwner = account.phase === "ready" && account.signedIn && account.tier === "admin";
  const groups = isOwner
    ? NAV_GROUPS.map((group, i) =>
        i === NAV_GROUPS.length - 1
          ? { ...group, items: [...group.items, OWNER_ITEM] }
          : group,
      )
    : NAV_GROUPS;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /*
    The state is the path the menu was opened on, not a boolean.

    That makes "a route change closes the menu" a derivation rather than an
    effect: press the browser's back button with the menu open and `open` is
    false on the very next render, with no effect to fire, nothing to clean up
    and no cascading re-render. The boolean version needed a
    useEffect(() => setOpen(false), [pathname]), which is the pattern
    react-hooks/set-state-in-effect exists to reject.
  */
  const [openPath, setOpenPath] = useState<string | null>(null);
  const open = openPath !== null && openPath === pathname;
  const close = () => setOpenPath(null);

  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      buttonRef.current?.focus();
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close();
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);

    /*
      Stop the page behind scrolling. The previous value is restored rather
      than cleared, so this cannot quietly undo an overflow style something
      else set — a test that runs while a modal is open, for instance.
    */
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
      document.body.style.overflow = previous;
    };
  }, [open]);

  const current = currentHref(pathname);

  if (onConsole) return null;

  return (
    /*
      --header-h is the header's own height, published as a custom property so
      the panel can hang off its bottom edge without either side hard-coding a
      number the other could change.
    */
    <header
      className="sticky top-0 z-40 border-b border-slate-200 bg-slate-50/85 backdrop-blur"
      style={{ "--header-h": "3.75rem" } as React.CSSProperties}
    >
      <div className="mx-auto flex h-[var(--header-h)] max-w-5xl items-center gap-2 px-4 sm:gap-3 sm:px-5 lg:max-w-6xl xl:max-w-7xl 2xl:max-w-[96rem]">
        <Link
          href="/"
          className="group flex shrink-0 items-center gap-2.5 text-[17px] font-semibold text-slate-900"
        >
          {/*
            The app icon, not a letter. `overflow-hidden` with the same radius
            is what rounds it: the artwork is a full-bleed square, the way an
            app icon has to be, so the corner has to be cut here rather than
            drawn into the file.

            Plain <img> rather than next/image: it is a 2 kB SVG at a fixed
            36px, so there is nothing to optimise, and next/image would need
            dangerouslyAllowSVG turned on for the whole app to serve it at all
            — widening what the image optimiser accepts, for one trusted logo.
            width and height are set so the header never reflows while it loads.
          */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/icons/final/steps-five-mark.svg"
            alt=""
            width={36}
            height={36}
            className="h-9 w-9 shrink-0 overflow-hidden rounded-2xl shadow-sm transition-transform group-hover:-rotate-6"
          />
          <span className="hidden xs:inline">BandUp</span>
        </Link>

        {/*
          The five daily destinations.

          Hidden while the menu is open, because the panel below lists all five
          again and a word should not appear twice on one screen claiming to be
          two different controls. Hidden below sm as well, where the logo and
          three controls already fill the row.
        */}
        {!open && (
          <nav
            aria-label="Main"
            className="hidden min-w-0 flex-1 items-center justify-center gap-0.5 text-sm sm:flex"
          >
            {PRIMARY.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={item.href === current ? "page" : undefined}
                className={`shrink-0 whitespace-nowrap rounded-xl px-2 py-2 transition-colors md:px-2.5 ${
                  item.href === current
                    ? "font-semibold text-slate-900"
                    : "text-slate-600 hover:bg-surface hover:text-slate-900"
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        )}
        {/* Takes the space the row would have, so the controls stay pinned
            right whenever the row is not there. */}
        <div className={open ? "flex-1" : "flex-1 sm:hidden"} />

        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <button
            ref={buttonRef}
            type="button"
            onClick={() => setOpenPath(open ? null : pathname)}
            aria-expanded={open}
            aria-controls="nav-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            className="rounded-xl px-2.5 py-2 text-slate-600 transition-colors hover:bg-surface hover:text-slate-900"
          >
            <svg
              viewBox="0 0 20 20"
              width="22"
              height="22"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              aria-hidden="true"
            >
              {open ? (
                <>
                  <path d="M5 5l10 10" />
                  <path d="M15 5L5 15" />
                </>
              ) : (
                <>
                  <path d="M3 6h14" />
                  <path d="M3 10h14" />
                  <path d="M3 14h14" />
                </>
              )}
            </svg>
          </button>
          {/*
            Account sits beside the theme toggle rather than in the row: it is
            not a destination in the way "Reading" is — most visits never need
            it, because everything on this app works signed out. It is in the
            menu too, under Help, so it is never icon-only.
          */}
          <Link
            href="/account"
            aria-label="Your account"
            className="rounded-xl px-2.5 py-2 text-sm text-slate-600 transition-colors hover:bg-surface hover:text-slate-900"
          >
            <svg
              viewBox="0 0 20 20"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="10" cy="6.5" r="3.2" />
              <path d="M3.8 17c0-3.3 2.8-5.4 6.2-5.4s6.2 2.1 6.2 5.4" />
            </svg>
          </Link>
          <ThemeToggle />
        </div>
      </div>

      {open && (
        <>
          {/*
            A dimmed backdrop under the panel. Purely visual — the outside tap
            is handled on the document, so this still works if a tap lands on
            something else entirely.
          */}
          <div
            aria-hidden="true"
            className="fixed inset-x-0 bottom-0 top-[var(--header-h)] z-30 bg-slate-900/20 backdrop-blur-[2px]"
          />
          <div
            ref={panelRef}
            id="nav-menu"
            className="fixed inset-x-0 top-[var(--header-h)] z-40 max-h-[calc(100dvh-var(--header-h))] overflow-y-auto border-b border-slate-200 bg-slate-50 shadow-lg"
          >
            <nav aria-label="All pages" className="mx-auto max-w-5xl px-4 py-5 sm:px-5 lg:max-w-6xl xl:max-w-7xl 2xl:max-w-[96rem]">
              <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
                {groups.map((group) => (
                  <div key={group.title}>
                    <h2 className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                      {group.title}
                    </h2>
                    <ul className="flex flex-col">
                      {group.items.map((item) => (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            aria-current={item.href === current ? "page" : undefined}
                            /*
                              Closing here rather than only on a route change: a
                              tap on the page you are already on changes no
                              route, and the menu would sit there looking broken.
                            */
                            onClick={close}
                            className={`flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-[16px] transition-colors ${
                              item.href === current
                                ? "bg-surface font-semibold text-slate-900"
                                : "text-slate-700 hover:bg-surface hover:text-slate-900"
                            }`}
                          >
                            <span>{item.label}</span>
                            {item.href === current && (
                              <span
                                aria-hidden="true"
                                className="h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-600"
                              />
                            )}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </nav>
          </div>
        </>
      )}
    </header>
  );
}
