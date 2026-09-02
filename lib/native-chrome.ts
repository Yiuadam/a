/*
  The web side of the bridge to NativeChromeView: ios/App/App/NativeChromePlugin.swift
  is the other half, and the pair replace the whole web header with a real
  UIGlassEffect bar drawn above the WKWebView — see NativeChromeView.swift for
  why a native view has to own its own buttons rather than sitting behind the
  DOM's.

  Everything here is guarded on `typeof window` because this module is
  imported from SiteHeader, which renders on the server first — the static
  export has no Capacitor bridge to find there, and none in an ordinary
  browser tab or the WeChat mini program's `<web-view>` either. Only inside
  the iOS app does `window.Capacitor` exist at all, injected before this
  script runs.

  No import from `@capacitor/core`, unlike lib/native.ts's use of
  `registerPlugin`. That call bakes in an assumption this module cannot make —
  that the plugin exists — and turns a missing one into a proxy that throws on
  every method instead of a plain absent value this file can just return null
  for.
*/

interface NativeChromeListenerHandle {
  remove(): Promise<void>;
}

/**
 * One destination, as the native list needs it.
 *
 * `icon` is the web's own key — "listening", "plan" — rather than an iOS asset
 * name. Which drawing that key resolves to is the native side's business; see
 * NavRowControl.artwork(for:) in ios/App/App/NativeNavListViewController.swift.
 */
export interface NativeNavItem {
  href: string;
  label: string;
  icon: string | null;
  current: boolean;
}

export interface NativeNavGroup {
  title: string;
  items: NativeNavItem[];
}

interface NativeChromePluginApi {
  enable(): Promise<{ height: number }>;
  disable(): Promise<void>;
  setTheme(options: { theme: string }): Promise<void>;
  setNavOpen(options: { open: boolean }): Promise<void>;
  setNavItems(options: { groups: NativeNavGroup[] }): Promise<void>;
  addListener(
    eventName: string,
    listenerFunc: (data: unknown) => void,
  ): Promise<NativeChromeListenerHandle>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: {
    NativeChrome?: NativeChromePluginApi;
  };
}

function getPlugin(): NativeChromePluginApi | null {
  if (typeof window === "undefined") return null;
  const capacitor = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  if (!capacitor?.isNativePlatform?.()) return null;
  return capacitor.Plugins?.NativeChrome ?? null;
}

/** True only inside the iOS app, where NativeChromePlugin is registered. */
export function isNativeChromeAvailable(): boolean {
  return getPlugin() !== null;
}

export async function enableNativeChrome(handlers: {
  onHome: () => void;
  onMenu: () => void;
  onAccount: () => void;
  onTheme: (theme: string) => void;
  /*
    A destination chosen in the native navigation list. The list is presented
    by the plugin rather than by this side — see toggleNavList in
    NativeChromePlugin.swift for why the menu button is answered natively —
    but it navigates nothing itself: the router lives here, so the href comes
    back and this side pushes it. Fired only once the zoom transition has
    finished unwinding, so the page underneath does not change while it is
    still being animated over.
  */
  onNavItem: (href: string) => void;
  /*
    The native list closed without a destination being chosen: the menu button
    tapped again, or the swipe-down Apple's zoom transition provides. Without
    this the web app's own `openPath` would go on claiming the menu is open
    long after it left the screen.
  */
  onNavDismissed: () => void;
  /*
    Rotation (or any other safe-area change) can move the bar's height after
    `enable` already resolved — see NativeChromePlugin's own heightChanged
    event. Optional because that is a concern for the one caller keeping a
    spacer in step with the bar, not part of the tap contract every other
    consumer would need.
  */
  onHeightChange?: (height: number) => void;
}): Promise<{ height: number; dispose: () => void } | null> {
  const plugin = getPlugin();
  if (!plugin) return null;

  const { height } = await plugin.enable();
  /*
    The one page token every page that fills the screen below the bar reads
    — see --header-h in app/globals.css. There it is the web header's own
    row height plus a zero env(safe-area-inset-top); here, inside the app,
    it is this bridge's only reason to touch the DOM directly rather than
    just handing the number to React: the real height is the row plus the
    real inset, and nothing about a page's own layout effect would know the
    difference between the two without it.
  */
  document.documentElement.style.setProperty("--header-h", `${height}px`);

  const handles = await Promise.all([
    plugin.addListener("homeTapped", () => handlers.onHome()),
    plugin.addListener("menuTapped", () => handlers.onMenu()),
    plugin.addListener("accountTapped", () => handlers.onAccount()),
    plugin.addListener("navItemSelected", (data) => {
      const href = (data as { href?: unknown } | undefined)?.href;
      if (typeof href === "string") handlers.onNavItem(href);
    }),
    plugin.addListener("navDismissed", () => handlers.onNavDismissed()),
    plugin.addListener("themeSelected", (data) => {
      const theme = (data as { theme?: unknown } | undefined)?.theme;
      if (typeof theme === "string") handlers.onTheme(theme);
    }),
    plugin.addListener("heightChanged", (data) => {
      const next = (data as { height?: unknown } | undefined)?.height;
      if (typeof next === "number") {
        document.documentElement.style.setProperty("--header-h", `${next}px`);
        handlers.onHeightChange?.(next);
      }
    }),
  ]);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const handle of handles) void handle.remove();
    void plugin.disable();
    // Leaving the last measured height behind would keep sizing every page
    // as if the native bar were still there after it is gone.
    document.documentElement.style.removeProperty("--header-h");
  };

  return { height, dispose };
}

/**
 * Tells the native bar the web theme changed, so its own selected dot agrees
 * without waiting for a tap on the bar itself to have caused it. Silent on
 * anything other than the iOS app — including a race where `enable` has not
 * resolved yet — because there is no web control for this to visibly fail in
 * front of.
 */
export function syncNativeTheme(theme: string): void {
  const plugin = getPlugin();
  if (!plugin) return;
  plugin.setTheme({ theme }).catch(() => {
    // Nothing to recover: the web theme already applied regardless.
  });
}

/**
 * Tells the native bar whether the navigation sheet is open, so it can take a
 * clearer material over it — the app's answer to `.nav-open-header` in
 * app/globals.css. The bar cannot work this out for itself: it raises
 * `menuTapped` and this side decides what that means, and the sheet closes by
 * Escape, by its close button, by a tap outside and by following a link, none
 * of which the bar ever hears about. Silent off the iOS app, and silent on a
 * rejection, for the same reason syncNativeTheme is: the sheet's own state
 * already applied and there is no web control here to fail in front of.
 */
export function setNativeNavOpen(open: boolean): void {
  const plugin = getPlugin();
  if (!plugin) return;
  plugin.setNavOpen({ open }).catch(() => {
    // Nothing to recover: the sheet is open or closed regardless.
  });
}

/**
 * Hands the native list every destination it should show.
 *
 * This is the whole reason the native menu is not a transcription of lib/nav.ts
 * into Swift. That file is the single source of truth for where the app can go,
 * it already varies by build — the iOS bundle drops /pricing and /billing,
 * because Apple requires digital content used in an app to be sold through
 * In-App Purchase — and it will keep changing. A Swift copy would drift
 * silently and a learner would be the one to find out, so the structure crosses
 * the bridge and the native side renders whatever it is given.
 *
 * Callable before `enable` has resolved: it only stores the structure on the
 * plugin, and the plugin does not need the bar to exist to hold it.
 */
export function setNativeNavItems(groups: NativeNavGroup[]): void {
  const plugin = getPlugin();
  if (!plugin) return;
  plugin.setNavItems({ groups }).catch(() => {
    // Nothing to recover, and nothing visibly broken: the native list simply
    // keeps whatever structure it was last given.
  });
}
