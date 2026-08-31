"use client";

import { useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent } from "react";
import { Icon } from "@/components/Icons";
import RefractiveGlassLayer from "@/components/RefractiveGlassLayer";
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
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  /* Distinct from `data-flowing`, which hover and keyboard focus also set:
     this is the finger actually being down, which is what the knob's bloom
     and its clear-glass state are answering. */
  const [pressed, setPressed] = useState(false);
  /*
    Where the knob actually is under the finger, as a fractional stop.

    A drag used to move it in whole stops, so it jumped between three fixed
    positions and sat still in between — and a lens that never moves has
    nothing new to bend. Carrying the position as a fraction of the same
    --theme-index the CSS already multiplies by the stop pitch means the
    knob tracks the pointer continuously, and every frame of that movement
    re-samples a different piece of the background through the rim.
  */
  const [dragPosition, setDragPosition] = useState<number | null>(null);
  const dragging = useRef(false);
  const dragIndex = useRef<number | null>(null);
  const selectedIndex = Math.max(0, THEMES.findIndex((option) => option.id === theme));
  const visibleIndex = previewIndex ?? selectedIndex;
  /* The fraction wins only while the finger is down; releasing hands the
     knob back to whole stops so it settles onto the choice. */
  const knobPosition = dragPosition ?? visibleIndex;

  /* The pointer's position in stop units. Half a stop is subtracted because
     the knob is placed by its left edge while the pointer aims at its
     middle, and it is clamped to the real stops so the knob never travels
     past either end of the track. */
  const positionAtPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const raw = ((event.clientX - rect.left) / rect.width) * THEMES.length - 0.5;
    return Math.max(0, Math.min(THEMES.length - 1, raw));
  };

  const previewAtPointer = (event: PointerEvent<HTMLDivElement>) => {
    const position = positionAtPointer(event);
    /* Rounded, not floored: the stop the knob is nearest to is the one it
       looks like it is on, and that has to be the one a release commits. */
    const index = Math.round(position);
    dragIndex.current = index;
    setDragPosition(position);
    setPreviewIndex(index);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      data-flowing={previewIndex !== null ? "" : undefined}
      data-pressed={pressed ? "" : undefined}
      className="theme-toggle-base premade-glass relative flex touch-none items-center gap-0.5 overflow-hidden rounded-xl p-0.5"
      style={{ "--theme-index": knobPosition } as CSSProperties}
      onPointerDown={(event) => {
        dragging.current = true;
        setPressed(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        previewAtPointer(event);
      }}
      onPointerMove={(event) => {
        if (dragging.current) previewAtPointer(event);
      }}
      onPointerUp={(event) => {
        if (!dragging.current) return;
        previewAtPointer(event);
        dragging.current = false;
        setPressed(false);
        setDragPosition(null);
        const index = dragIndex.current;
        if (index !== null) setTheme(THEMES[index].id);
        dragIndex.current = null;
        setPreviewIndex(null);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = false;
        setPressed(false);
        setDragPosition(null);
        dragIndex.current = null;
        setPreviewIndex(null);
      }}
      onPointerLeave={() => {
        if (!dragging.current) setPreviewIndex(null);
      }}
    >
      <RefractiveGlassLayer radius={14} interactive />
      <span className="theme-toggle-selector" aria-hidden="true" />
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
            onPointerEnter={() => {
              dragIndex.current = index;
              setPreviewIndex(index);
            }}
            onFocus={() => setPreviewIndex(index)}
            onBlur={() => setPreviewIndex(null)}
            onClick={() => {
              setTheme(t.id);
              setPreviewIndex(null);
            }}
            className={`app-icon-control relative z-10 flex h-7 w-7 items-center justify-center rounded-lg text-sm transition-colors focus-visible:outline-none ${
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
