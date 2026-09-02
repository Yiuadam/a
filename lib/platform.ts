/*
  Which build this is.

  Apple requires digital content consumed inside an iOS app to be sold through
  In-App Purchase and takes 30% of it. BandUp's answer is the one Netflix and
  Kindle use: the iOS app sells nothing at all. There is no checkout in it, no
  price, no button and no link to one — so there is no in-app purchase to take
  a cut of, and nothing for review to reject.

  Two halves make that true, and both are needed:

    scripts/build-mobile.mjs moves /pricing and /billing out of the export, so
      the routes are not in the bundle at all rather than merely hidden;

    this flag stops the rest of the app pointing at them, because a link to a
      route that is not there is a broken link, and a "Subscribe" button in an
      iOS build is the thing review looks for.

  A subscription bought on the web works in the app immediately: entitlement is
  resolved server-side from the account (lib/billing/entitlements.ts), so the
  app only has to sign in.

  Adapted from lib/platform.ts on claude/stripe-ielts-integration-rd7dzv, which
  reached the same conclusion first.
*/

/**
 * True only in the static bundle that ships inside the iOS app.
 *
 * Set by scripts/build-mobile.mjs. NEXT_PUBLIC_ so it survives into the client
 * bundle — this decides what is drawn, so it has to be readable where the
 * drawing happens. It holds nothing secret: it is the string "1".
 */
export const IS_MOBILE_BUILD = process.env.NEXT_PUBLIC_MOBILE_BUILD === "1";

/**
 * A pathname in the one form the app compares routes in: no trailing slash,
 * except at the root, which is nothing but one.
 *
 * The static export sets `trailingSlash: true` — see next.config.ts — because a
 * bundle served off the filesystem inside a WebView resolves a page by asking a
 * directory for its index.html. That is invisible until something compares a
 * route by name, and then it is not: `usePathname()` answers "/practice/writing/"
 * inside the iOS app where it answers "/practice/writing" on the website, so
 * every `pathname === "/practice/writing"` in the app is quietly false and every
 * decision hanging off one silently takes the other branch. It is how the
 * writing exam came to scroll on a phone with the site's footer underneath it:
 * the viewport lock and the footer's hide list both name that route, and in the
 * app neither name ever matched.
 *
 * The translation happens here, once, rather than at the comparisons, because
 * there are eighteen of them across seven files and a rule written eighteen
 * times is a rule that will be written seventeen times after the next page is
 * added. Doing it here also settles which form is canonical: the route names in
 * lib/nav.ts stay slash-free, the website's shape is the shape the code is
 * written in, and the app is the one thing translated on the way in.
 *
 * Only for comparing. A path being *navigated* to keeps whatever form the
 * platform produced, because the slash is what the export's own router expects
 * and stripping it off a destination is how a redirect arrives somewhere nobody
 * asked to go.
 *
 * "/" is the exception worth stating rather than leaving to be discovered:
 * strip its slash and it becomes "", which is not a route and matches nothing.
 */
export function routePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/**
 * Where a subscription is bought and managed. Named in prose, never linked
 * from the iOS build — a link out to a purchase page is the part Apple's
 * guidelines are actually about.
 */
export const WEB_HOME = "bandup.life";

/**
 * The origin to put in a link someone else will open.
 *
 * `window.location.origin` is the obvious answer and the wrong one inside the
 * iOS app, where it is `capacitor://localhost` — a scheme that exists only on
 * that one phone. An organisation invite built from it is a link no invitee
 * can open, which is a failure the manager who sent it never sees.
 *
 * The mobile build already knows where the real site is, because every API
 * call it makes goes there; that is the value to reach for. On the web the
 * variable is empty and the current origin is right, which also keeps preview
 * deployments generating links back to themselves rather than to production.
 */
export function shareableOrigin(): string {
  const configured = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/$/, "");
  if (configured) return configured;
  if (typeof window !== "undefined") return window.location.origin;
  return `https://${WEB_HOME}`;
}

/**
 * True when the page is running inside the WeChat mini program's web-view.
 *
 * Runtime rather than build-time, unlike IS_MOBILE_BUILD, and it has to be:
 * the mini program does not carry its own copy of the site the way the iOS
 * app does. It points a `<web-view>` at the live deployment, so the same
 * bundle serves the browser and the mini program and only the page itself can
 * tell which it is in.
 *
 * Three signals, because no one of them is reliable on its own. WeChat sets
 * `__wxjs_environment` on the window, but not until its own bridge script has
 * run, which can be after first paint. The user agent carries "miniProgram"
 * on most clients and not on all of them. So the mini program also puts a
 * marker in the URL it opens, which is true from the very first frame — see
 * miniprogram/pages/index/index.js, which appends it.
 */
export function isMiniProgramShell() {
  if (typeof window === "undefined") return false;
  const wx = window as unknown as { __wxjs_environment?: string };
  if (wx.__wxjs_environment === "miniprogram") return true;
  if (/miniprogram/i.test(navigator.userAgent)) return true;
  try {
    if (new URLSearchParams(window.location.search).get("shell") === MINIPROGRAM_SHELL) {
      /* Remembered as it is read. Only the first page the mini program opens
         carries the query string; every link followed from it is an ordinary
         in-app navigation that would otherwise look like a plain browser
         again, and the glass would come back halfway through a session. */
      window.sessionStorage.setItem(MINIPROGRAM_SHELL_STORE, "1");
      return true;
    }
    return window.sessionStorage.getItem(MINIPROGRAM_SHELL_STORE) === "1";
  } catch {
    /* Private modes and embedded web-views can both throw on storage rather
       than return null. Not being able to read the marker is not evidence
       either way, and the two signals above have already had their say. */
    return false;
  }
}

/** The value of the `shell` query parameter the mini program opens with. */
export const MINIPROGRAM_SHELL = "miniprogram";

/** Where that marker is remembered for the rest of the session. */
export const MINIPROGRAM_SHELL_STORE = "bandup.shell.miniprogram";
