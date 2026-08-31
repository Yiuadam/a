"use client";

import { useSyncExternalStore, type CSSProperties } from "react";
import { Icon } from "@/components/Icons";
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
 * knob, deform it and carry it under a finger, and the other two were left
 * jumping between whole stops until the behaviour was lifted out. Keeping it
 * here again would mean writing that three times to reach every option bar.
 *
 * A tap commits below, in the option's own click. A drag has no click on the
 * option it ends over, so it commits through the hook's onCommit instead —
 * one or the other fires, never both.
 */
export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getServerTheme);
  const selectedIndex = Math.max(0, THEMES.findIndex((option) => option.id === theme));
  const drag = useSegmentedDrag({
    count: THEMES.length,
    selectedIndex,
    onCommit: (index) => setTheme(THEMES[index].id),
  });
  const visibleIndex = drag.previewIndex ?? selectedIndex;

  return (
    /* touch-none is what the drag costs the page: a finger sliding across
       this bar carries the knob rather than scrolling, so the control keeps a
       gesture the page would otherwise have had. Worth it here because it is
       a small target in the header, not a wide band a thumb lands on by
       accident on the way down a long page. */
    <div
      role="radiogroup"
      aria-label="Colour theme"
      data-flowing={drag.previewIndex !== null ? "" : undefined}
      data-pressed={drag.pressed ? "" : undefined}
      data-settling={drag.settling ? "" : undefined}
      className="theme-toggle-base premade-glass relative flex touch-none items-center gap-0.5 overflow-hidden rounded-xl p-0.5"
      style={
        {
          "--theme-index": drag.position,
          "--segmented-squash": drag.squash,
        } as CSSProperties
      }
      {...drag.handlers}
    >
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
