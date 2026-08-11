"use client";

import { useSyncExternalStore, useState } from "react";
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

  Opened as a small popover rather than a modal, because a modal over an exam
  paper hides the thing you are trying to size correctly. You change the size,
  you watch the passage behind it change, you close it.
*/
export function useExamDisplay() {
  return useSyncExternalStore(subscribeDisplay, getDisplay, getServerDisplay);
}

export default function ExamSettings() {
  const display = useExamDisplay();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="rounded border border-[color:var(--exam-line)] px-2.5 py-1.5 text-xs font-semibold text-[color:var(--exam-fg)] transition-colors hover:bg-[color:var(--exam-hover)]"
      >
        Settings
      </button>

      {open && (
        <>
          {/*
            A click-catcher rather than a focus trap. The panel is two radio
            groups; trapping focus in it would make closing harder than opening,
            which is the wrong trade for something a candidate opens mid-exam.
          */}
          <button
            type="button"
            aria-label="Close settings"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="dialog"
            aria-label="Display settings"
            className="absolute right-0 top-full z-50 mt-2 w-64 rounded border border-[color:var(--exam-line)] bg-[color:var(--exam-chrome)] p-3 shadow-lg"
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
                    className={`rounded border px-1 py-1.5 text-xs font-semibold transition-colors ${
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
                    className={`flex w-full items-center justify-between gap-2 rounded border px-2 py-1.5 text-left text-xs transition-colors ${
                      display.scheme === scheme.id
                        ? "border-[color:var(--exam-fg)]"
                        : "border-[color:var(--exam-line)] hover:bg-[color:var(--exam-hover)]"
                    }`}
                  >
                    <span className="text-[color:var(--exam-fg)]">{scheme.label}</span>
                    {/* A swatch in the actual colours, so the label is checkable. */}
                    <span
                      aria-hidden="true"
                      className="flex h-5 w-8 shrink-0 items-center justify-center rounded-[2px] border border-[color:var(--exam-line)] text-[10px] font-bold"
                      style={
                        scheme.id === "standard"
                          ? {
                              background: "var(--color-background)",
                              color: "var(--color-foreground)",
                            }
                          : scheme.id === "reverse"
                            ? { background: "#000000", color: "#ffffff" }
                            : { background: "#000000", color: "#ffd400" }
                      }
                    >
                      Aa
                    </span>
                  </button>
                ))}
              </div>
            </fieldset>
          </div>
        </>
      )}
    </div>
  );
}
