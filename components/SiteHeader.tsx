"use client";

import { Suspense, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import Image from "next/image";
import Link from "next/link";
import SignInLink from "@/components/account/SignInLink";
import { usePathname, useRouter } from "next/navigation";
import ThemeToggle from "@/components/ThemeToggle";
import { NAV_GROUPS, OWNER_ITEM, PRIMARY, currentHref } from "@/lib/nav";
import { useTier } from "@/lib/billing/useTier";
import CardIcon, { type CardIconName } from "@/components/CardIcon";
import { Icon } from "@/components/Icons";
import { IS_MOBILE_BUILD } from "@/lib/platform";
import HeaderNotificationBell from "@/components/account/HeaderNotificationBell";
import { useAccountProfile } from "@/components/account/AccountProfileProvider";
import bandupMarkRear from "@/components/assets/steps-five-layer-rear-108.png";
import { enableNativeChrome, syncNativeTheme } from "@/lib/native-chrome";
import { getServerTheme, getTheme, setTheme, subscribeTheme, type Theme } from "@/lib/theme";

const HOMEPAGE_MENU_ICONS: Partial<Record<string, string>> = {
  "/practice/listening": "listening",
  "/practice/reading": "reading",
  "/practice/writing": "writing",
  "/speaking": "speaking",
  "/grammar": "grammar",
  "/vocabulary": "vocabulary",
};

/*
  Mirrors the unexported guard of the same name in lib/theme.ts. Duplicated
  rather than imported because it isn't exported there — everywhere in that
  file already knows its strings come from THEMES, and this is the one caller
  outside it that takes a theme from somewhere else entirely: the native bar,
  arriving as a plain string off the other side of the Capacitor bridge.
*/
function isTheme(value: string): value is Theme {
  return value === "warm" || value === "light" || value === "dark";
}

const MENU_ICONS: Partial<Record<string, CardIconName>> = {
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
  ...(!IS_MOBILE_BUILD
    ? { "/pricing": "plans" as const, "/billing": "usage" as const }
    : {}),
  "/admin": "settings",
};

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

export default function SiteHeader({
  isolatedOrganizationPreview = false,
}: {
  isolatedOrganizationPreview?: boolean;
}) {
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
  const onHome = pathname === "/";

  const account = useTier();
  const { profile } = useAccountProfile();
  const isOwner = account.phase === "ready" && account.signedIn && account.tier === "admin";
  const groups = isOwner && !IS_MOBILE_BUILD
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
  const [menuPreview, setMenuPreview] = useState<{ group: number; item: number } | null>(null);
  const open = openPath !== null && openPath === pathname;
  const close = () => setOpenPath(null);

  /*
    Set once NativeChromeView is actually up and has reported its height;
    null covers both "not the iOS app" and "the iOS app, but the bridge call
    has not resolved yet". See the effect below for why that second state is
    unavoidable rather than merely unhandled.
  */
  const [nativeChromeHeight, setNativeChromeHeight] = useState<number | null>(null);

  /*
    The sheet is `fixed inset-x-0`, so its own left edge is always the
    viewport's — the menu button's position within that width is the one
    thing CSS alone cannot know. Read it here, before paint, and hand it to
    the stylesheet as a variable: the opening animation reads from the
    button outward instead of growing from the middle of the screen.
    useLayoutEffect rather than the effect below it, so this is set on the
    same frame the sheet mounts and the very first paint already has it —
    an ordinary effect would let one frame render at the 50% fallback first.
  */
  useLayoutEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      panelRef.current?.style.setProperty("--nav-origin-x", `${rect.left + rect.width / 2}px`);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      buttonRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);

    /*
      Stop the page behind scrolling. The previous value is restored rather
      than cleared, so this cannot quietly undo an overflow style something
      else set — a test that runs while a modal is open, for instance.
    */
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    /*
      The menu is a real full-screen navigation state, not translucent scenery
      over a still-interactive homepage. Remove the document beneath it from
      both pointer and accessibility navigation until the menu closes.
    */
    const behind = Array.from(document.querySelectorAll<HTMLElement>("main, footer"));
    const previousBehind = behind.map((node) => ({
      node,
      inert: node.inert,
      ariaHidden: node.getAttribute("aria-hidden"),
    }));
    for (const node of behind) {
      node.inert = true;
      node.setAttribute("aria-hidden", "true");
    }

    const focusFrame = requestAnimationFrame(() => {
      panelRef.current?.focus();
    });

    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      for (const item of previousBehind) {
        item.node.inert = item.inert;
        if (item.ariaHidden === null) item.node.removeAttribute("aria-hidden");
        else item.node.setAttribute("aria-hidden", item.ariaHidden);
      }
    };
  }, [open]);

  const router = useRouter();
  /*
    The handlers registered below are set up once, on mount, and outlive
    every navigation — see the effect two below for why. A ref is what lets
    them still answer with the page a tap actually landed on rather than
    whichever page happened to be current when `enable` was called; it is
    kept current from its own effect; refs cannot be written during render.
  */
  const pathnameRef = useRef(pathname);
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  /*
    The theme this tab is showing, read only to hand it to the native bar.
    Nothing here draws with it — every visible use of the theme still lives
    in ThemeToggle, which keeps its own subscription to the same store.
  */
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getServerTheme);
  useEffect(() => {
    syncNativeTheme(theme);
  }, [theme]);

  /*
    NativeChromeView replacing this component's own <header> entirely, on
    the one platform that has it. `enable` is an async bridge call, so the
    very first frame inside the iOS app still paints the ordinary web header
    below — there is no way to know synchronously, on first render, that a
    native replacement is coming without the server (which has never heard
    of Capacitor) and the client disagreeing about that first frame. It
    settles within one bridge round trip, which is the compromise made here
    rather than a defect: brief, and only ever on cold start.

    The effect itself runs once rather than on every pathname change —
    `enable` creates the native view a single time, and re-running it on
    navigation would tear the glass bar down and rebuild it on every link
    tapped from the very menu it draws. `router` is a stable reference from
    Next.js for the life of the app, so this fires on mount and cleans up on
    unmount and nowhere in between.
  */
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | null = null;

    enableNativeChrome({
      // The logo is reachable from the open menu too, so closing it here as
      // well as navigating keeps a tap home from leaving the sheet standing
      // over the page it just left. setOpenPath directly, not the `close`
      // wrapper — this effect runs once, on mount, and only ever closes
      // over values that stay valid for the app's life; `close` is a new
      // function every render and would owe this effect a dependency the
      // same way `onMenu` avoids one below by reading pathnameRef instead
      // of pathname.
      onHome: () => {
        router.push("/");
        setOpenPath(null);
      },
      onMenu: () => {
        setOpenPath((current) => (current === pathnameRef.current ? null : pathnameRef.current));
      },
      onAccount: () => router.push("/account"),
      onTheme: (nextTheme) => {
        if (isTheme(nextTheme)) setTheme(nextTheme);
      },
      onHeightChange: (height) => setNativeChromeHeight(height),
    }).then((result) => {
      if (!result) return;
      if (cancelled) {
        result.dispose();
        return;
      }
      dispose = result.dispose;
      setNativeChromeHeight(result.height);
      // The bar is built with its own "warm" default and has no way to know
      // otherwise; the ongoing sync above only fires on a later *change*, so
      // whatever this tab is already showing has to be pushed once, now.
      syncNativeTheme(getTheme());
    }).catch(() => {
      // enable() rejects only if the app's own view hierarchy is not there
      // to attach to, which is not a state this tab can recover from. The
      // web header this effect leaves standing is the correct fallback, not
      // a broken one — it is the same header every other platform already
      // renders — so there is nothing to do here beyond not crashing on it.
    });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [router]);

  const current = currentHref(pathname);

  if (onConsole) return null;

  /*
    The navigation sheet — every destination, not just the five-word row
    above it — is the same list in both branches below, so it is built once
    here rather than twice. Two separate copies is exactly how the native
    bar's menu button went dead: this JSX used to live only in the web
    branch, inside the very `<header>` the native branch never rendered, so
    toggling `open` had nothing left to show for it. A plain function rather
    than a component used as `<NavSheet />` is deliberate — a component
    defined inside another component's render gets a new identity on every
    render, and React remounts it instead of updating it, which would replay
    the opening animation and drop focus every time a pointer moves over a
    row and `menuPreview` changes. Calling this and inlining its return value
    instead produces the exact same element at the exact same place in the
    tree, so reconciliation treats it exactly as it did when this JSX sat
    here directly.
  */
  function renderNavSheet() {
    if (!open) return null;
    return (
      <div
        ref={panelRef}
        id="nav-menu"
        role="dialog"
        aria-modal="true"
        aria-label="Site navigation"
        tabIndex={-1}
        className="nav-paper premade-glass fixed inset-x-0 bottom-0 top-[var(--header-h)] z-40 overflow-y-auto outline-none"
      >
          <nav aria-label="All pages" className="premade-glass-content mx-auto max-w-5xl px-4 py-5 sm:px-5 sm:py-7 lg:max-w-6xl xl:max-w-7xl 2xl:max-w-[96rem]">
            <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
              {groups.map((group, groupIndex) => {
                const selectedIndex = group.items.findIndex((item) => item.href === current);
                /*
                  One highlight in the whole menu, not one per group.

                  Each group used to fall back to its own selected row
                  whenever the pointer was somewhere else, which meant
                  hovering a row in one group lit it up while the group
                  holding the current page went on showing its own — two
                  pills at once, and neither of them obviously the live
                  one. So a group that is not being pointed at yields its
                  highlight entirely: while any group has the pointer, only
                  that group draws one.

                  The pinned row is not a separate thing that gets hidden,
                  it is the same single highlight moving. Hovering inside
                  the group that holds the current page slides it from that
                  row to the pointer's, on the 440ms travel the selector
                  already had, and letting go returns it. Across groups the
                  move cannot be a slide — each selector is positioned
                  inside its own list, and the groups are separate boxes in
                  a grid that reflows from three columns to one — so it
                  changes place rather than travelling there.
                */
                const visibleIndex = menuPreview
                  ? (menuPreview.group === groupIndex ? menuPreview.item : -1)
                  : selectedIndex;
                return (
                <div
                  key={group.title}
                  className="nav-menu-group liquid-glass rounded-2xl border p-3 sm:p-4"
                >
                  <h2 className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {group.title}
                  </h2>
                  <ul
                    className="relative flex flex-col"
                    onPointerLeave={() => setMenuPreview(null)}
                    style={{ "--nav-row-index": visibleIndex } as React.CSSProperties}
                  >
                    {visibleIndex >= 0 && <span className="nav-menu-selector" aria-hidden="true" />}
                    {group.items.map((item, itemIndex) => {
                      const icon = MENU_ICONS[item.href];
                      const homepageIcon = HOMEPAGE_MENU_ICONS[item.href];
                      return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          prefetch={false}
                          aria-current={item.href === current ? "page" : undefined}
                          /*
                            Closing here rather than only on a route change: a
                            tap on the page you are already on changes no
                            route, and the menu would sit there looking broken.
                          */
                          onClick={close}
                          onPointerEnter={() => setMenuPreview({ group: groupIndex, item: itemIndex })}
                          onFocus={() => setMenuPreview({ group: groupIndex, item: itemIndex })}
                          onBlur={() => setMenuPreview(null)}
                          className={`relative z-10 flex min-h-11 items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-[16px] font-semibold transition-colors ${
                            item.href === current
                              ? "text-slate-900"
                              : "text-slate-700 hover:text-slate-900"
                          }`}
                        >
                          <span className="flex min-w-0 items-center gap-2.5">
                            {homepageIcon ? (
                              <Icon
                                name={homepageIcon}
                                className="h-[21px] w-[21px] shrink-0 text-indigo-600"
                              />
                            ) : icon ? (
                              <CardIcon name={icon} size={21} />
                            ) : null}
                            <span>{item.label}</span>
                          </span>
                        </Link>
                      </li>
                      );
                    })}
                  </ul>
                </div>
                );
              })}
            </div>
          </nav>
      </div>
    );
  }

  if (nativeChromeHeight !== null) {
    /*
      Real estate the native bar already owns above the web view. The row —
      logo, menu button, account button, theme toggle — belongs here even
      less than the rest of the header does: NativeChromeView has already
      drawn the menu, account and theme controls themselves, in real
      UIGlassEffect glass rather than the CSS bevel this file falls back to
      everywhere the app runs in a browser engine that cannot filter a
      backdrop it did not paint itself. The sheet those controls open is not
      something native draws, though — nothing on the other side of the
      bridge knows what the menu button should reveal — so it still renders
      here, wrapped in a plain div rather than the `<header>` the web branch
      uses to publish `--header-h`. That div exists for exactly one
      property: there is no header element in this branch for the sheet to
      inherit the variable from, so it is set from the bar's own measured
      height instead, which already includes the safe-area inset the same
      way the web branch's own calc() does.
    */
    const sheet = renderNavSheet();
    return (
      <>
        <div aria-hidden="true" style={{ height: nativeChromeHeight }} />
        {sheet && (
          <div style={{ "--header-h": `${nativeChromeHeight}px` } as React.CSSProperties}>
            {sheet}
          </div>
        )}
      </>
    );
  }

  return (
    /*
      --header-h is the header's own height, published as a custom property so
      the panel can hang off its bottom edge without either side hard-coding a
      number the other could change.
    */
    <header
      className={`site-header ${open ? "nav-open-header z-[1000]" : "liquid-glass z-40"} sticky top-0 border-b`}
      style={{
        "--header-row-h": "3.75rem",
        "--header-h": "calc(var(--header-row-h) + env(safe-area-inset-top))",
      } as React.CSSProperties}
    >
      <div className="mx-auto flex h-[var(--header-row-h)] max-w-5xl items-center gap-2 px-4 sm:gap-3 sm:px-5 lg:max-w-6xl xl:max-w-7xl 2xl:max-w-[96rem]">
        <Link
          href="/"
          prefetch={false}
          className="group flex shrink-0 items-center gap-2.5 text-[17px] font-semibold text-slate-900"
        >
          {/*
            The app icon, not a letter. `overflow-hidden` with the same radius
            is what rounds it: the artwork is a full-bleed square, the way an
            app icon has to be, so the corner has to be cut here rather than
            drawn into the file.

            The selected 3D PNG is kept crisp in a header-sized, content-hashed
            derivative, rather than sending the 1.6 MB artwork master through
            an image optimiser on every uncached visit.
          */}
          <span
            data-pointer-attract
            data-pointer-attract-strength="icon"
            className="bandup-mark relative h-9 w-9 shrink-0 overflow-hidden rounded-2xl shadow-sm"
          >
            <Image
              src={bandupMarkRear}
              alt=""
              fill
              sizes="36px"
              className="bandup-mark-rear object-cover"
              unoptimized
              priority
            />
            <svg
              viewBox="0 0 1254 1254"
              className="bandup-mark-front absolute inset-0 h-full w-full"
              fill="none"
              aria-hidden="true"
            >
              <defs>
                <linearGradient id="bandup-glass-rim" x1="260" y1="250" x2="1010" y2="1080">
                  <stop stopColor="white" stopOpacity="0.96" />
                  <stop offset="0.45" stopColor="#dce5e7" stopOpacity="0.58" />
                  <stop offset="1" stopColor="white" stopOpacity="0.88" />
                </linearGradient>
                <filter id="bandup-glass-depth" x="-20%" y="-20%" width="140%" height="150%">
                  <feDropShadow dx="0" dy="8" stdDeviation="8" floodColor="#090603" floodOpacity="0.24" />
                </filter>
              </defs>
              <path
                d="M252 1010V774H398V650H548V526H708V405H866V300H990V1038Z"
                fill="white"
                fillOpacity="0.035"
                stroke="url(#bandup-glass-rim)"
                strokeWidth="10"
                strokeLinejoin="round"
                filter="url(#bandup-glass-depth)"
              />
              <rect
                x="438"
                y="760"
                width="410"
                height="42"
                rx="21"
                fill="#29150d"
                fillOpacity="0.55"
                stroke="url(#bandup-glass-rim)"
                strokeWidth="8"
              />
              <rect
                x="355"
                y="850"
                width="330"
                height="42"
                rx="21"
                fill="#29150d"
                fillOpacity="0.55"
                stroke="url(#bandup-glass-rim)"
                strokeWidth="8"
              />
            </svg>
          </span>
          <span className="hidden xs:inline">BandUp</span>
        </Link>

        {/*
          The five daily destinations.

          Hidden while the menu is open, because the panel below lists all five
          again and a word should not appear twice on one screen claiming to be
          two different controls. Hidden below lg as well, where the logo and
          three controls already fill the row. `lg` is intentional: at `sm`
          the links technically fit alone, but not beside the brand, menu,
          account and theme controls.
        */}
        {!open && !onHome && (
          <PrimaryNavigation current={current} />
        )}
        {/* Takes the space the row would have, so the controls stay pinned
            right whenever the row is not there. */}
        <div className={open || onHome ? "flex-1" : "flex-1 lg:hidden"} />

        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <button
            ref={buttonRef}
            type="button"
            onClick={() => setOpenPath(open ? null : pathname)}
            aria-expanded={open}
            aria-controls="nav-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            className="app-icon-control rounded-xl px-2.5 py-2 transition-colors hover:bg-surface"
          >
            <svg
              viewBox="0 0 20 20"
              width="22"
              height="22"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
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
          <Suspense fallback={null}>
            <HeaderNotificationBell
              signedIn={account.signedIn}
              isolatedOrganizationPreview={isolatedOrganizationPreview}
            />
          </Suspense>
          {/*
            Account sits beside the theme toggle rather than in the row: it is
            not a destination in the way "Reading" is — most visits never need
            it, because everything on this app works signed out. It is in the
            menu too, under Help, so it is never icon-only.
          */}
          <SignInLink
            href="/account"
            prefetch={false}
            aria-label="Your account"
            data-pointer-attract
            data-pointer-attract-strength="icon"
            className="pointer-attract-glass premade-glass app-icon-control relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border text-sm transition-all"
          >
            {account.signedIn && profile?.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={profile.avatarUrl}
                alt=""
                decoding="async"
                className="relative z-10 h-full w-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : account.signedIn ? (
              <span className="relative z-10 flex h-full w-full items-center justify-center bg-indigo-100 text-xs font-semibold uppercase text-indigo-700">
                {(profile?.displayName ?? profile?.email ?? "A").trim().charAt(0) || "A"}
              </span>
            ) : (
              <svg
                className="app-icon-color relative z-10"
                viewBox="0 0 20 20"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <circle cx="10" cy="6.5" r="3.2" />
                <path d="M3.8 17c0-3.3 2.8-5.4 6.2-5.4s6.2 2.1 6.2 5.4" />
              </svg>
            )}
          </SignInLink>
          {/* Held off the theme control so the account button sits clear of
              it rather than crowding its rim — the cluster is right-aligned,
              so widening this gap moves the account (and the menu) left. */}
          <div className="ml-2 sm:ml-3">
            <ThemeToggle />
          </div>
        </div>
      </div>

      {renderNavSheet()}
    </header>
  );
}

function PrimaryNavigation({ current }: { current: string | null }) {
  const links = useRef<Array<HTMLAnchorElement | null>>([]);
  const nav = useRef<HTMLElement | null>(null);
  const selected = PRIMARY.findIndex((item) => item.href === current);
  const [preview, setPreview] = useState<number | null>(null);
  const visible = preview ?? selected;
  const [selector, setSelector] = useState<{ left: number; width: number } | null>(null);

  useEffect(() => {
    const measure = () => {
      const item = links.current[visible];
      const parent = nav.current;
      if (!item || !parent || visible < 0) {
        setSelector(null);
        return;
      }
      const itemRect = item.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      setSelector({ left: itemRect.left - parentRect.left, width: itemRect.width });
    };

    const frame = requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    if (nav.current) observer.observe(nav.current);
    for (const item of links.current) if (item) observer.observe(item);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [visible]);

  return (
    <nav
      ref={nav}
      aria-label="Main"
      onPointerLeave={() => setPreview(null)}
      className="relative hidden min-w-0 flex-1 items-center justify-center gap-0.5 text-sm lg:flex"
    >
      {selector && (
        <span
          className="nav-primary-selector"
          style={{ left: selector.left, width: selector.width }}
          aria-hidden="true"
        />
      )}
      {PRIMARY.map((item, index) => (
        <Link
          ref={(node) => {
            links.current[index] = node;
          }}
          key={item.href}
          href={item.href}
          prefetch={false}
          aria-current={item.href === current ? "page" : undefined}
          onPointerEnter={() => setPreview(index)}
          onFocus={() => setPreview(index)}
          onBlur={() => setPreview(null)}
          className={`relative z-10 shrink-0 whitespace-nowrap rounded-xl px-2 py-2 transition-colors md:px-2.5 ${
            item.href === current
              ? "font-semibold text-slate-900"
              : "text-slate-600 hover:text-slate-900"
          }`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
