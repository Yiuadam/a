"use client";

import { Suspense, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Route } from "next";
import Link from "next/link";
import SignInLink from "@/components/account/SignInLink";
import { useRouter } from "next/navigation";
import { useRoutePath } from "@/lib/hooks";
import ThemeToggle from "@/components/ThemeToggle";
import { NAV_GROUPS, OWNER_ITEM, PRIMARY, currentHref, hasSideRail } from "@/lib/nav";
import { useTier } from "@/lib/billing/useTier";
import CardIcon, { type CardIconName } from "@/components/CardIcon";
import { Icon } from "@/components/Icons";
import { IS_MOBILE_BUILD } from "@/lib/platform";
import HeaderNotificationBell from "@/components/account/HeaderNotificationBell";
import { useAccountProfile } from "@/components/account/AccountProfileProvider";
import BandUpMark from "@/components/BandUpMark";
import {
  enableNativeChrome,
  setNativeAccount,
  setNativeNavItems,
  setNativeNavOpen,
  syncNativeTheme,
  type NativeAccountFace,
  type NativeNavGroup,
} from "@/lib/native-chrome";
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
  Which glyph a destination carries, as one name.

  The two tables above draw from different icon families — HOMEPAGE_MENU_ICONS
  from components/Icons.tsx, MENU_ICONS from components/CardIcon.tsx — but they
  are keyed by href and their key sets do not overlap, so a merge in the same
  order the sheet's own JSX resolves them in is the whole of the rule.

  It exists for the iOS app. The native navigation list draws the website's own
  artwork rather than SF Symbols, and it is handed this name rather than a
  picture: which drawing the name resolves to is decided on the other side of
  the bridge, against traced copies of these same paths in Assets.xcassets.
*/
function navIconName(href: string): string | null {
  return HOMEPAGE_MENU_ICONS[href] ?? MENU_ICONS[href] ?? null;
}

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
  /* useRoutePath, not usePathname, so that the route this header reads is the
     same route lib/nav.ts names — the iOS export's own pathname has a trailing
     slash on it and those names do not. See routePath in lib/platform.ts. */
  const pathname = useRoutePath();

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
  /*
    The console is in the app now. It used to be website-only because
    `output: export` cannot build a route with a dynamic segment and
    /admin/users/[id] has two — so the whole of app/admin was moved aside for
    the mobile build and a link to it would have led nowhere. Those two screens
    now have query-string twins that the app ships instead
    (lib/admin/user-links.ts), so the section is reachable and the row belongs
    here again.
  */
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

  /* Which destination this page is "on", or null. Read by both the sheet
     below and the structure handed to the native list, so the two mark the
     same row. */
  const current = currentHref(pathname);

  /*
    The same telling-the-native-bar for the menu's open state, so it can take
    a clearer glass over the sheet the way `.nav-open-header` does on the web.

    Keyed on `open` itself rather than hung off the button's onClick, and that
    is the whole point of writing it as an effect: `open` is derived from
    openPath and pathname together, so it also goes false when Escape fires,
    when the close button is pressed, when a tap lands outside, and when a
    link inside the sheet navigates away. Any of those paths would have left
    the bar wearing the open material with nothing open underneath it.
  */
  useEffect(() => {
    setNativeNavOpen(open);
  }, [open]);

  /*
    The menu's whole structure, pushed to the native list.

    lib/nav.ts stays the single source of truth for where the app can go, and
    nothing about these sixteen rows is written down in Swift. That matters
    more than it looks: NAV_GROUPS already varies by build — it drops /pricing
    and /billing under IS_MOBILE_BUILD — and it will keep changing, so a native
    copy would drift silently and a learner would be the one to find out.

    Serialised to compare, then parsed to send. The array `groups` is rebuilt
    on every render, so it can never be a useEffect dependency; its JSON can,
    and it also means an identical menu is not pushed across the bridge again
    on every keystroke elsewhere in the app. Skipped entirely until the native
    bar has reported in, so the website pays nothing for it.
  */
  const nativeNav =
    nativeChromeHeight === null
      ? null
      : JSON.stringify(
          groups.map((group) => ({
            title: group.title,
            items: group.items.map((item) => ({
              href: item.href,
              label: item.label,
              icon: navIconName(item.href),
              current: item.href === current,
            })),
          })),
        );
  useEffect(() => {
    if (nativeNav === null) return;
    setNativeNavItems(JSON.parse(nativeNav) as NativeNavGroup[]);
  }, [nativeNav]);

  /*
    The account button's face, pushed to the native bar for the same reason
    the menu's structure is: the app's top bar is native, so the three states
    rendered below — the photo, the initial, the generic glyph — cannot reach
    it through the DOM at all.

    The two values that decide those states cross rather than the decision
    itself, so the native button draws them the way it draws every other
    control up there. Kept deliberately in step with the JSX below: the same
    `account.signedIn` gate, the same displayName-then-email-then-"A" fallback.
    Serialised for the same reason nativeNav is — an object rebuilt every
    render can never be a dependency, and its JSON also stops an unchanged face
    being pushed again on every keystroke elsewhere in the app.

    Signing out is not a special case, it is the third state: both fields go
    null and the push is what clears the face off the bar. That is the one of
    the three that must not be missed, so it travels the same path as the
    other two rather than hanging off a sign-out handler somewhere.
  */
  const nativeAccount =
    nativeChromeHeight === null
      ? null
      : JSON.stringify({
          avatarUrl: (account.signedIn && profile?.avatarUrl) || null,
          initial: account.signedIn
            ? (profile?.displayName ?? profile?.email ?? "A").trim().charAt(0) || "A"
            : null,
        } satisfies NativeAccountFace);
  useEffect(() => {
    if (nativeAccount === null) return;
    setNativeAccount(JSON.parse(nativeAccount) as NativeAccountFace);
  }, [nativeAccount]);

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
      /*
        Opens rather than toggles, because the native side is what actually
        decides now: the plugin presents its own list from the menu button so
        Apple's zoom transition can originate there, and it reports back which
        of the two happened — `menuTapped` on the way up, `navDismissed` on the
        way down. A toggle here would fight that, since a second tap on the
        button arrives as navDismissed and never as menuTapped.
      */
      onMenu: () => setOpenPath(pathnameRef.current),
      onNavItem: (href) => {
        /*
          The native list navigates nothing itself. It has already dismissed
          by the time this arrives — the transition unwinds first, then the
          page changes, rather than the web view being torn out from under a
          zoom still animating over it.
        */
        router.push(href as Route);
        setOpenPath(null);
      },
      onNavDismissed: () => setOpenPath(null),
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

  /*
    Not simply `if (onConsole) return null` — that was the bug.

    The console draws its own header and wants nothing from this component on
    an ordinary web tab, where returning null here is the whole story: nothing
    else on the page is expecting header space to have been reserved for it.

    Inside the app it is a different question. The glass bar above the WebView
    is native and floats there on every screen this component ever mounts on,
    /admin included — enableNativeChrome runs unconditionally above, before
    either return, because it lives in an effect and the rules of hooks do not
    let it wait for `onConsole` to be known. Returning null before the spacer
    branch below skipped the one thing that keeps that bar from floating over
    a page's own content: the invisible div that reserves its height in DOM
    flow. Every other page gets that div. The console did not, and its own
    title sat under the bar as a result — the report was "the top is being
    cut", and it was, by exactly `nativeChromeHeight` pixels.
  */
  if (onConsole && nativeChromeHeight === null) return null;

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
                          className={`relative z-10 flex min-h-11 items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-[1rem] font-semibold transition-colors ${
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
      Nothing but the space the native bar already occupies above the web view.

      The row — logo, menu button, account button, theme toggle — belongs here
      even less than the rest of the header does: NativeChromeView has drawn
      those controls itself, in real UIGlassEffect glass rather than the CSS
      bevel this file falls back to everywhere the app runs in a browser engine
      that cannot filter a backdrop it did not paint itself.

      The sheet is gone from this branch too, and that is the change. It used
      to render here because nothing on the other side of the bridge knew what
      the menu button should reveal — but its opening animation is a CSS
      transform-origin read off the button's own bounding rect, and inside the
      app that button is not in the DOM at all, so the list grew from the middle
      of the screen instead of out of the control that opened it. The app now
      presents a native list from the button with Apple's zoom transition, which
      is the one arrangement where a native button and the surface it opens are
      one continuous piece of motion. Rendering this sheet as well would put the
      same sixteen destinations on screen twice.

      renderNavSheet is still called by the web branch below, unchanged: the
      website's own sheet is exactly what it was.
    */
    return <div aria-hidden="true" style={{ height: nativeChromeHeight }} />;
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
      {/* `relative` so the nav row can centre itself on the bar rather than on
          whatever space is left between the wordmark and the controls — see
          PrimaryNavigation. */}
      <div className="relative mx-auto flex h-[var(--header-row-h)] max-w-5xl items-center gap-2 px-4 sm:gap-3 sm:px-5 lg:max-w-6xl xl:max-w-7xl 2xl:max-w-[96rem]">
        <Link
          href="/"
          prefetch={false}
          className="group flex shrink-0 items-center gap-2.5 text-[1.0625rem] font-semibold text-slate-900"
        >
          {/*
            The app icon, not a letter. `overflow-hidden` with the same radius
            is what rounds it: the artwork is a full-bleed square, the way an
            app icon has to be, so the corner has to be cut here rather than
            drawn into the file.

            The mark itself is drawn rather than fetched — see
            components/BandUpMark.tsx — so there is no artwork to optimise and
            nothing to request.
          */}
          {/*
            No pointer attraction and no hover lift. Both were drawn for the
            raster mark, where the two layers parting read as the material
            catching the light; on the drawn mark, at 36px, a logo that leans
            toward the cursor reads as a logo that is not fixed to the page.
            Every other icon in the header keeps its attraction — they are
            controls, and a control that reaches for the pointer is inviting a
            click. The wordmark is not inviting anything.
          */}
          <span className="bandup-mark relative h-9 w-9 shrink-0 overflow-hidden rounded-2xl shadow-sm">
            <BandUpMark className="bandup-mark-rear h-full w-full" />
            {/*
              The glass rim that used to sit here is gone. It was a second SVG
              laid over the mark — a specular edge and a stepped path drawn to
              a 1254 viewBox — and it lined up with the raster tile it was
              made for, not with the drawn mark that replaced it. On screen
              that was a pale stepped shape sitting slightly off the logo,
              which reads as a rendering fault rather than as a highlight.

              Nothing replaces it. The mark is three layers and their colours
              already say which is in front; a rim is what a device draws over
              a Liquid Glass icon on a home screen, and the header is not one.
            */}
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
          <PrimaryNavigation current={current} railed={hasSideRail(pathname)} />
        )}
        {/*
          The spacer that pushes the controls to the right edge, on every route
          and at every width.

          It was conditional twice over, and both conditions were left behind by
          changes to what they described. It first hid itself at `lg` because
          the row of primary links carried `flex-1` up there and did the
          pushing; then the links were taken out of the flow and pinned to the
          middle of the bar, at which point nothing was pushing anything and the
          menu, bell, account and theme toggle collapsed against the wordmark on
          every wide screen that was not the homepage or a railed page.

          There is no case left where the spacer should not grow: the links are
          absolutely positioned now, so they occupy no space to give. Unconditional
          is not a simplification here, it is the correct rule — these four
          controls are the same four in the same order on every page, and a
          person navigating by muscle memory should never have to look for them.
        */}
        <div className="flex-1" />

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

function PrimaryNavigation({ current, railed }: { current: string | null; railed: boolean }) {
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
      /*
        Hidden exactly where the rail stands, which is the same `lg` this row
        used to appear at — the five destinations here are the first five in
        the rail, and naming them twice on one screen is how a header starts
        arguing with the page. On a route with no rail it is unchanged.

        Centred on the bar, not on the space between its neighbours. `flex-1`
        with `justify-center` centres the row inside whatever is left after the
        wordmark and the controls, and those two are different widths — so the
        links sat visibly left of centre on every page that draws them. Taking
        it out of the flow and pinning it to the middle is the only way to mean
        the middle of the header.
      */
      className={`absolute left-1/2 hidden min-w-0 -translate-x-1/2 items-center justify-center gap-0.5 text-sm ${
        railed ? "" : "lg:flex"
      }`}
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
