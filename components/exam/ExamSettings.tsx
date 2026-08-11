"use client";

import { createPortal } from "react-dom";
import {
  useEffect,
  useRef,
  useSyncExternalStore,
  useState,
  type CSSProperties,
} from "react";
import {
  SCHEMES,
  TEXT_SIZES,
  getDisplay,
  getServerDisplay,
  setDisplay,
  subscribeDisplay,
} from "@/lib/exam/display";

/*
  The Settings button in the top-right corner, and the two things behind it.

  The real exam has exactly these: text size, and text colour on background
  colour. No theme picker, no font choice, no density. Adding more would be
  designing a settings panel rather than reproducing an exam, and the whole
  value of this screen is that somebody who has practised on it recognises the
  real one.

  Opened as a focused glass popover. The paper remains visible as blurred shape
  and light, but its words cannot compete with the controls.
*/
export function useExamDisplay() {
  return useSyncExternalStore(subscribeDisplay, getDisplay, getServerDisplay);
}

export default function ExamSettings() {
  const display = useExamDisplay();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties | null>(null);

  useEffect(() => {
    if (!open) return;

    const update = () => {
      if (!trigger.current) return;
      const rect = trigger.current.getBoundingClientRect();
      const computed = getComputedStyle(trigger.current);
      const width = Math.min(288, window.innerWidth - 24);
      const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
      const variables = [
        "--exam-bg",
        "--exam-fg",
        "--exam-muted",
        "--exam-line",
        "--exam-chrome",
        "--exam-hover",
        "--exam-accent",
      ].reduce<Record<string, string>>((values, name) => {
        values[name] = computed.getPropertyValue(name);
        return values;
      }, {});

      setPopoverStyle({
        ...variables,
        left,
        top: rect.bottom + 8,
        width,
        fontSize: computed.fontSize,
      });
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, display.scheme]);

  return (
    <div className="relative">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="exam-settings-trigger exam-glass rounded-lg border px-3 py-1.5 text-xs font-semibold text-[color:var(--exam-fg)] transition-colors"
      >
        Settings
      </button>

      {open && popoverStyle &&
        createPortal(
          <div data-exam="" className="fixed inset-0 z-[1000] pointer-events-none">
            <button
              type="button"
              aria-label="Close settings"
              className="pointer-events-auto absolute inset-0 cursor-default"
              onClick={() => setOpen(false)}
            />
            <div
              role="dialog"
              aria-label="Display settings"
              style={popoverStyle}
              className="exam-settings-popover pointer-events-auto fixed rounded-2xl border p-3"
            >
            <fieldset>
              <legend className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--exam-muted)]">
                Text size
              </legend>
              <div className="mt-1.5 grid grid-cols-4 gap-1">
                {TEXT_SIZES.map((size) => (
                  <button
                    key={size.id}
                    type="button"
                    onClick={() => setDisplay({ size: size.id })}
                    aria-pressed={display.size === size.id}
                    className={`rounded-2xl border px-1 py-1.5 text-xs font-semibold transition-colors ${
                      display.size === size.id
                        ? "border-[color:var(--exam-fg)] bg-[color:var(--exam-fg)] text-[color:var(--exam-bg)]"
                        : "border-[color:var(--exam-line)] text-[color:var(--exam-fg)] hover:bg-[color:var(--exam-hover)]"
                    }`}
                  >
                    {/* The control is the thing it does: each label is set at its own size. */}
                    <span style={{ fontSize: Math.round(size.px * 0.7) }}>A</span>
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="mt-3">
              <legend className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--exam-muted)]">
                Colours
              </legend>
              <div className="mt-1.5 space-y-1">
                {SCHEMES.map((scheme) => (
                  <button
                    key={scheme.id}
                    type="button"
                    onClick={() => setDisplay({ scheme: scheme.id })}
                    aria-pressed={display.scheme === scheme.id}
                    className={`flex w-full items-center justify-between gap-2 rounded-2xl border px-2 py-1.5 text-left text-xs transition-colors ${
                      display.scheme === scheme.id
                        ? "border-[color:var(--exam-fg)]"
                        : "border-[color:var(--exam-line)] hover:bg-[color:var(--exam-hover)]"
                    }`}
                  >
                    <span className="text-[color:var(--exam-fg)]">{scheme.label}</span>
                    {/* A swatch in the actual colours, so the label is checkable. */}
                    <span
                      aria-hidden="true"
                      className="flex h-5 w-8 shrink-0 items-center justify-center rounded-2xl border border-[color:var(--exam-line)] text-[10px] font-bold"
                      style={
                        scheme.id === "standard"
                          ? {
                              background: "var(--color-background)",
                              color: "var(--color-foreground)",
                            }
                          : { background: "#000000", color: "#ffffff" }
                      }
                    >
                      Aa
                    </span>
                  </button>
                ))}
              </div>
            </fieldset>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
