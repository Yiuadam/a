"use client";

import { useSyncExternalStore, type CSSProperties } from "react";
import { Icon } from "@/components/Icons";
import RefractiveGlassLayer from "@/components/RefractiveGlassLayer";
import { useSegmentedDrag } from "@/lib/segmented-drag";
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
 *
 * How it answers a pointer lives in useSegmentedDrag, shared with the
 * organisation sections and the notification filter. This control had its own
 * copy of that logic for a while — it was the one that learned to lift the
 * knob and deform it, and the other two were left jumping between whole stops
 * until the behaviour was lifted out. Keeping it here again would mean writing
 * that three times to reach every option bar.
 *
 * The choice itself is committed here, in the option's own click, which is why
 * the hook has nothing to say about committing.
 */
export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getServerTheme);
  const selectedIndex = Math.max(0, THEMES.findIndex((option) => option.id === theme));
  const drag = useSegmentedDrag({ selectedIndex });
  const visibleIndex = drag.previewIndex ?? selectedIndex;

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      data-flowing={drag.previewIndex !== null ? "" : undefined}
      data-pressed={drag.pressed ? "" : undefined}
      data-settling={drag.settling ? "" : undefined}
      className="theme-toggle-base premade-glass relative flex items-center gap-0.5 overflow-hidden rounded-xl p-0.5"
      style={
        {
          "--theme-index": drag.position,
          "--segmented-squash": drag.squash,
        } as CSSProperties
      }
      {...drag.handlers}
    >
      <RefractiveGlassLayer radius={14} interactive />
      {/*
        The knob. On engines that displace a backdrop it is an empty disc
        and the lens does the rest; on WebKit, which will not filter a
        backdrop by any route, it carries its own copy of the track and
        bends that instead — see supportsCloneLens in
        GlassRefractionFilter. The copy is inert in both cases when the
        clone path is off, because the CSS only paints it under
        html[data-glass-lens-clone].
      */}
      <span className="theme-toggle-selector" aria-hidden="true">
        <span className="theme-knob-refraction">
          <span className="theme-knob-refraction-copy">
            {THEMES.map((t) => (
              <span className="theme-toggle-option app-icon-control" key={t.id}>
                <Icon
                  name={t.icon}
                  className={`h-4 w-4 ${t.id === "warm" ? "-translate-y-0.5" : ""}`}
                />
              </span>
            ))}
          </span>
        </span>
      </span>
      {THEMES.map((t, index) => {
        const active = theme === t.id;
        const visible = visibleIndex === index;
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${t.label} theme`}
            title={t.hint}
            onPointerEnter={() => drag.preview(index)}
            onFocus={() => drag.preview(index)}
            onBlur={() => drag.preview(null)}
            onClick={() => {
              setTheme(t.id);
              drag.preview(null);
            }}
            className={`theme-toggle-option app-icon-control relative z-10 flex items-center justify-center rounded-lg text-sm transition-colors focus-visible:outline-none ${
              visible ? "text-slate-900" : "text-slate-500 hover:text-slate-800"
            }`}
          >
            <Icon
              name={t.icon}
              className={`h-4 w-4 ${t.id === "warm" ? "-translate-y-0.5" : ""}`}
            />
          </button>
        );
      })}
    </div>
  );
}
