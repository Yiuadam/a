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
  const dragging = useRef(false);
  const dragIndex = useRef<number | null>(null);
  const selectedIndex = Math.max(0, THEMES.findIndex((option) => option.id === theme));
  const visibleIndex = previewIndex ?? selectedIndex;

  const indexAtPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const index = Math.floor(((event.clientX - rect.left) / rect.width) * THEMES.length);
    return Math.max(0, Math.min(THEMES.length - 1, index));
  };

  const previewAtPointer = (event: PointerEvent<HTMLDivElement>) => {
    const index = indexAtPointer(event);
    dragIndex.current = index;
    setPreviewIndex(index);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      data-flowing={previewIndex !== null ? "" : undefined}
      className="theme-toggle-base premade-glass relative flex touch-none items-center gap-0.5 overflow-hidden rounded-xl p-0.5"
      style={{ "--theme-index": visibleIndex } as CSSProperties}
      onPointerDown={(event) => {
        dragging.current = true;
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
        const index = dragIndex.current;
        if (index !== null) setTheme(THEMES[index].id);
        dragIndex.current = null;
        setPreviewIndex(null);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = false;
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
