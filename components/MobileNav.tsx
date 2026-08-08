"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/*
  The menu, everywhere below lg.

  What it replaces: the header's destinations used to sit in a horizontal
  scroller on narrow screens. That kept the page from ever widening, which was
  the point, but it hid most of the app behind a gesture with no affordance —
  eight destinations, three visible, and nothing on screen saying the other
  five existed.

  "Below lg", not "on a phone", and that is the measured number rather than a
  guess: nine destinations need 690px of header and the header has that only
  from 1024px up. The inline row used to appear from md, where it did not fit
  and overflowed straight over the account button.

  A button and a full-width list is the ordinary answer, and ordinary is what
  a navigation control should be. Everything here is about it behaving the way
  a person already expects:

    Escape closes it, and focus goes back to the button that opened it.
    A tap outside closes it.
    Following a link closes it — including a link to the page you are already
      on, where the route never changes and nothing would otherwise happen.
    The page behind it cannot scroll while it is open.
    The current page is marked, so opening the menu tells you where you are.

  The list is rendered only when open. Keeping it mounted and hidden would put
  a second copy of every destination in the accessibility tree and in the tab
  order on a wide screen, where this component is not shown at all.
*/

export interface NavItem {
  href: string;
  label: string;
}

export default function MobileNav({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname();
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

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpenPath(open ? null : pathname)}
        aria-expanded={open}
        aria-controls="mobile-nav"
        aria-label={open ? "Close menu" : "Open menu"}
        className="rounded-xl px-2.5 py-2 text-slate-600 transition-colors hover:bg-surface hover:text-slate-900 lg:hidden"
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

      {open && (
        <>
          {/*
            A dimmed backdrop under the panel. Purely visual — the outside tap
            is handled on the document, so this still works if a tap lands on
            something else entirely.
          */}
          <div
            aria-hidden="true"
            className="fixed inset-x-0 bottom-0 top-[var(--header-h)] z-30 bg-slate-900/20 backdrop-blur-[2px] lg:hidden"
          />
          <div
            ref={panelRef}
            id="mobile-nav"
            className="fixed inset-x-0 top-[var(--header-h)] z-40 max-h-[calc(100dvh-var(--header-h))] overflow-y-auto border-b border-slate-200 bg-slate-50 shadow-lg lg:hidden"
          >
            <nav aria-label="Main" className="mx-auto max-w-5xl px-4 py-3">
              <ul className="flex flex-col">
                {items.map((item) => {
                  const current =
                    item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={current ? "page" : undefined}
                        /*
                          Closing here rather than only on a route change: a tap
                          on the page you are already on changes no route, and
                          the menu would sit there looking broken.
                        */
                        onClick={close}
                        className={`flex items-center justify-between rounded-xl px-3 py-3.5 text-[17px] transition-colors ${
                          current
                            ? "bg-surface font-semibold text-slate-900"
                            : "text-slate-700 hover:bg-surface hover:text-slate-900"
                        }`}
                      >
                        {item.label}
                        {current && (
                          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-indigo-600" />
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
          </div>
        </>
      )}
    </>
  );
}
