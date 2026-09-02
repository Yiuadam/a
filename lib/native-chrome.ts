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

interface NativeChromePluginApi {
  enable(): Promise<{ height: number }>;
  disable(): Promise<void>;
  setTheme(options: { theme: string }): Promise<void>;
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
