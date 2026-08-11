"use client";

import { useSyncExternalStore } from "react";
import { Icon } from "@/components/Icons";
import {
  THEMES,
  getServerTheme,
  getTheme,
  setTheme,
  subscribeTheme,
} from "@/lib/theme";

/**
 * A three-way segmented control rather than a cycling button: all the options
 * are visible, and you can see which one you are on without clicking anything.
 */
export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getServerTheme);

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="liquid-glass flex items-center gap-0.5 rounded-xl border p-0.5"
    >
      {THEMES.map((t) => {
        const active = theme === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${t.label} theme`}
            title={t.hint}
            onClick={() => setTheme(t.id)}
            className={`flex h-7 w-7 items-center justify-center rounded-lg text-sm transition-all ${
              active
                ? "bg-indigo-600 text-accent-fg shadow-sm"
                : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            }`}
          >
            <Icon name={t.icon} className="h-4 w-4" />
          </button>
        );
      })}
    </div>
  );
}
