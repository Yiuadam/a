"use client";

import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import RefractiveGlassLayer from "@/components/RefractiveGlassLayer";

export interface GlassSelectOption {
  value: string;
  label: string;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className={`app-icon-color size-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}>
      <path d="m5.5 7.5 4.5 4.5 4.5-4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="app-icon-color size-4 shrink-0">
      <circle cx="8.5" cy="8.5" r="4.75" stroke="currentColor" strokeWidth="1.65" />
      <path d="m12 12 4.25 4.25" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="app-icon-color size-4">
      <path d="m5 5 10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function FloatingGlassPopover({
  anchor,
  ariaLabel,
  multiselectable = false,
  minWidth = 128,
  onClose,
  children,
}: {
  anchor: HTMLElement | null;
  ariaLabel: string;
  multiselectable?: boolean;
  minWidth?: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const gutter = 8;
      const width = Math.min(Math.max(rect.width, minWidth), window.innerWidth - gutter * 2);
      const roomBelow = window.innerHeight - rect.bottom - gutter;
      const roomAbove = rect.top - gutter;
      const openAbove = roomBelow < 170 && roomAbove > roomBelow;
      const left = Math.max(gutter, Math.min(rect.left, window.innerWidth - width - gutter));
      setPosition({
        position: "fixed",
        zIndex: 100,
        left,
        width,
        maxHeight: Math.max(112, Math.min(208, (openAbove ? roomAbove : roomBelow) - gutter)),
        /*
          The button can sit anywhere the popover then has to avoid running
          off-screen from, so `left` above and this origin can diverge —
          expressed as an offset from the popover's own left edge, in the
          same box the animation itself transforms, rather than a viewport
          coordinate the animation would have to re-derive.
        */
        transformOrigin: `${rect.left + rect.width / 2 - left}px ${openAbove ? "100%" : "0%"}`,
        ...(openAbove
          ? { bottom: window.innerHeight - rect.top + 6 }
          : { top: rect.bottom + 6 }),
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor, minWidth]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !anchor?.contains(target)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        anchor?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [anchor, onClose]);

  if (!anchor || !position) return null;
  return createPortal(
    <div
      ref={menuRef}
      role="listbox"
      aria-label={ariaLabel}
      aria-multiselectable={multiselectable || undefined}
      style={position}
      className="liquid-glass organization-picker-popover premade-glass overflow-y-auto rounded-xl border border-slate-200 p-1.5 shadow-lg"
    >
      <RefractiveGlassLayer radius={12} interactive />
      <div className="premade-glass-content">{children}</div>
    </div>,
    document.body,
  );
}

export default function GlassSelect({
  label,
  value,
  options,
  onValueChange,
  placeholder = "Choose",
  disabled = false,
  compact = false,
  className = "",
  minMenuWidth = 128,
  fullPageThreshold = 12,
}: {
  label: string;
  value: string;
  options: readonly GlassSelectOption[];
  onValueChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
  minMenuWidth?: number;
  /** Long option sets open in a searchable, full-page chooser. Set to Infinity to always use a popover. */
  fullPageThreshold?: number;
}) {
  const [open, setOpen] = useState(false);
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const dialogTitleId = useId();
  const selected = options.find((option) => option.value === value);
  const usesFullPageChooser = options.length >= fullPageThreshold;
  const visibleOptions = usesFullPageChooser
    ? options.filter((option) => option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    : options;

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) button?.focus();
  }, [button]);

  const choose = useCallback((nextValue: string) => {
    onValueChange(nextValue);
    close(true);
  }, [close, onValueChange]);

  useEffect(() => {
    if (!open || !usesFullPageChooser) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    document.addEventListener("keydown", onKeyDown);
    const focusTimer = window.setTimeout(() => searchInput.current?.focus(), 0);
    return () => {
      document.body.style.overflow = originalOverflow;
      document.removeEventListener("keydown", onKeyDown);
      window.clearTimeout(focusTimer);
    };
  }, [close, open, usesFullPageChooser]);

  return (
    <div className={`relative min-w-0 ${className}`}>
      <button
        ref={setButton}
        type="button"
        aria-label={label}
        aria-haspopup={usesFullPageChooser ? "dialog" : "listbox"}
        aria-expanded={open}
        disabled={disabled}
        className={`liquid-glass flex w-full items-center justify-between gap-2 rounded-xl border border-slate-300 bg-surface/45 text-left text-slate-900 disabled:cursor-not-allowed disabled:opacity-55 ${compact ? "min-h-8 px-2.5 text-xs" : "min-h-11 px-3 text-sm"}`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="truncate">{selected?.label ?? placeholder}</span>
        <Chevron open={open} />
      </button>
      {open && usesFullPageChooser && createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={dialogTitleId}
          className="fixed inset-0 z-[120] flex min-h-dvh flex-col bg-surface/96 text-slate-900 backdrop-blur-2xl"
        >
          <header className="flex items-center justify-between gap-4 border-b border-slate-300/70 px-4 py-3.5 sm:px-6">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">Choose</p>
              <h2 id={dialogTitleId} className="mt-0.5 truncate text-lg font-semibold tracking-tight sm:text-xl">{label}</h2>
            </div>
            <button
              type="button"
              aria-label={`Close ${label}`}
              onClick={() => close(true)}
              className="liquid-glass inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-slate-300 bg-surface/55 text-slate-700 hover:bg-surface/80"
            >
              <CloseIcon />
            </button>
          </header>

          <div className="mx-auto flex w-full max-w-3xl min-h-0 flex-1 flex-col px-4 py-4 sm:px-6 sm:py-5">
            <label className="liquid-glass flex min-h-11 shrink-0 items-center gap-2.5 rounded-2xl border border-slate-300 bg-surface/55 px-3.5 shadow-sm">
              <SearchIcon />
              <span className="sr-only">Search {label}</span>
              <input
                ref={searchInput}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${label.toLocaleLowerCase()}`}
                className="min-w-0 flex-1 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-500 sm:text-base"
              />
              <span className="shrink-0 text-xs tabular-nums text-slate-500">{visibleOptions.length}</span>
            </label>

            <div role="listbox" aria-label={label} className="mt-3 min-h-0 overflow-y-auto overscroll-contain pb-6">
              <div className="grid auto-rows-[4.75rem] gap-2 sm:grid-cols-2">
                {visibleOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    className={`liquid-glass flex h-full min-w-0 items-center justify-between gap-3 overflow-hidden rounded-2xl border px-3.5 py-2.5 text-left text-sm transition-colors sm:text-base ${option.value === value ? "border-indigo-500/45 bg-indigo-100/55 text-slate-900" : "border-slate-300 bg-surface/55 text-slate-700 hover:bg-surface/85"}`}
                    onClick={() => choose(option.value)}
                  >
                    <span className="line-clamp-2 min-w-0 flex-1">{option.label}</span>
                    {option.value === value && <span aria-hidden="true" className="shrink-0 font-semibold text-indigo-700">Selected</span>}
                  </button>
                ))}
              </div>
              {visibleOptions.length === 0 && (
                <p className="py-10 text-center text-sm text-slate-500">No matching options.</p>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
      {open && !usesFullPageChooser && (
        <FloatingGlassPopover
          anchor={button}
          ariaLabel={label}
          minWidth={minMenuWidth}
          onClose={() => close()}
        >
          {visibleOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`flex min-h-9 w-full items-center justify-between gap-3 rounded-lg px-2.5 text-left text-sm ${option.value === value ? "bg-indigo-100/65 text-slate-900" : "text-slate-700 hover:bg-surface/55"}`}
              onClick={() => {
                choose(option.value);
              }}
            >
              <span className="truncate">{option.label}</span>
              {option.value === value && <span aria-hidden="true" className="text-indigo-700">✓</span>}
            </button>
          ))}
        </FloatingGlassPopover>
      )}
    </div>
  );
}
