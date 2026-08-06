export type Theme = "warm" | "light" | "dark";

export const THEMES: { id: Theme; label: string; icon: string; hint: string }[] = [
  { id: "warm", label: "Warm", icon: "☕", hint: "Cream paper and clay — easiest on the eyes" },
  { id: "light", label: "Light", icon: "☀", hint: "Crisp white and indigo" },
  { id: "dark", label: "Dark", icon: "☾", hint: "Low light, for late sessions" },
];

export const THEME_KEY = "bandup.theme";

/**
 * Runs before first paint, inlined into the document head.
 *
 * Applying the stored theme from an effect would show the default palette for
 * a frame first, which reads as a flash of the wrong colours on every page
 * load. Setting the attribute synchronously avoids that entirely.
 */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(
  THEME_KEY,
)});document.documentElement.dataset.theme=(t==="light"||t==="dark"||t==="warm")?t:"warm"}catch(e){}`;

function isTheme(value: unknown): value is Theme {
  return value === "warm" || value === "light" || value === "dark";
}

// Same external-store shape as lib/store.ts: read once, cache, notify.
let cached: Theme | null = null;
const listeners = new Set<() => void>();

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTheme(): Theme {
  if (cached) return cached;
  if (typeof window === "undefined") return "warm";
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(THEME_KEY);
  } catch {
    // Private browsing can throw on access; the default is fine.
  }
  cached = isTheme(stored) ? stored : "warm";
  return cached;
}

/** SSR and hydration both use the default, matching the pre-paint script. */
export function getServerTheme(): Theme {
  return "warm";
}

export function setTheme(theme: Theme): void {
  cached = theme;
  if (typeof document !== "undefined") document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Nothing to do — the theme still applies for this session.
  }
  for (const listener of listeners) listener();
}
