"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MODULE_GROUPS, MODULE_LIBRARY, type ModuleId } from "@/lib/dashboard/layout";

/*
  The library, as a dialog over the board, showing each module as it will look.

  A written description is not a preview. "Your last six sittings and the band
  each one earned" tells somebody what the module contains and nothing about
  whether they want it on their page, which is a question about how much room
  it takes and what it looks like next to the others. So each entry renders the
  real component — the same node the board would draw — scaled down inside a
  frame.

  Scaled rather than rebuilt, and that is the point: a hand-drawn thumbnail is
  a second copy of the design that goes stale the first time the real one
  changes. `transform: scale` on the live element cannot go stale, and it costs
  nothing but a paint.

  The preview is inert — `pointer-events: none` and `aria-hidden` — because it
  is a picture of a control, not a control. Without that, a learner could open
  the tutor from inside a dialog about arranging the page, and a screen reader
  would read every module's contents twice.
*/

export default function ModuleLibrary({
  layout,
  modules,
  onAdd,
  onReset,
  open,
  onOpen,
  onClose,
}: {
  layout: readonly ModuleId[];
  modules: Partial<Record<ModuleId, ReactNode>>;
  onAdd: (id: ModuleId) => void;
  onReset: () => void;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<string | null>(null);

  /*
    Modules already on the board are still listed, marked and not addable,
    rather than disappearing. A library that silently shrinks as you use it
    makes somebody hunt for the thing they added a minute ago to check they
    added it; showing everything and saying which are placed answers that
    without a hunt.
  */
  const needle = query.trim().toLowerCase();
  const listed = MODULE_LIBRARY.filter(
    (m) =>
      (group === null || m.group === group) &&
      (needle === "" ||
        m.name.toLowerCase().includes(needle) ||
        m.blurb.toLowerCase().includes(needle)),
  );

  /* Escape closes, and focus moves into the dialog so a keyboard is not left
     behind on the page underneath. */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    panel.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" onClick={onOpen} className="btn-primary !min-h-9 text-[0.875rem]">
          Add a module
        </button>
      </div>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          /*
            Portalled to the body for the reason every overlay in this app is:
            the header and the cards are backdrop roots, and a blurred surface
            inside one of them flattens against it instead of the page.
          */
          <div className="fixed inset-0 z-[140] flex items-end justify-center p-0 sm:items-center sm:p-6">
            <button
              type="button"
              aria-label="Close the module library"
              onClick={onClose}
              className="absolute inset-0 cursor-default bg-[color:color-mix(in_srgb,var(--color-slate-900)_38%,transparent)]"
            />
            <div
              ref={panel}
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              aria-labelledby="module-library-heading"
              className="card liquid-glass relative max-h-[86dvh] w-full max-w-4xl overflow-y-auto !p-5 sm:max-h-[80dvh]"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2
                    id="module-library-heading"
                    className="text-[1.0625rem] font-semibold text-slate-900"
                  >
                    Module library
                  </h2>
                  <p className="mt-0.5 text-[0.875rem] leading-6 text-slate-600">
                    Each one is shown as it will appear. Add it, then drag it where you want it.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close the module library"
                  className="btn-secondary shrink-0 !min-h-9 !w-9 !px-0"
                >
                  <svg
                    viewBox="0 0 20 20"
                    width="13"
                    height="13"
                    aria-hidden="true"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  >
                    <path d="M5 5l10 10" />
                    <path d="M15 5L5 15" />
                  </svg>
                </button>
              </div>

              <div className="mt-4 grid min-h-0 gap-4 sm:grid-cols-[11rem_minmax(0,1fr)]">
                <div className="min-w-0">
                  <label className="sr-only" htmlFor="module-search">
                    Search modules
                  </label>
                  <input
                    id="module-search"
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search modules"
                    className="input w-full !py-2 text-[0.875rem]"
                  />
                  <ul className="mt-2 space-y-0.5">
                    {[null, ...MODULE_GROUPS].map((name) => (
                      <li key={name ?? "all"}>
                        <button
                          type="button"
                          onClick={() => setGroup(name)}
                          aria-current={group === name ? "true" : undefined}
                          className={`side-rail-item flex min-h-9 w-full items-center rounded-full px-3 text-[0.875rem] font-medium transition-colors ${
                            group === name
                              ? "side-rail-item-active text-slate-900"
                              : "text-slate-600 hover:text-slate-900"
                          }`}
                        >
                          {name ?? "All modules"}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>

                {listed.length === 0 ? (
                  <p className="text-[0.875rem] text-slate-600">
                    Nothing matches “{query}”.
                  </p>
                ) : (
                  <ul className="grid min-w-0 gap-3 sm:grid-cols-2">
                    {listed.map((m) => {
                      const placed = layout.includes(m.id);
                      return (
                        <li key={m.id} className="min-w-0">
                          <div className="flex h-full min-w-0 flex-col rounded-2xl border border-[color:var(--glass-edge)] p-3">
                            <div className="min-w-0">
                              <p className="text-[0.9375rem] font-semibold text-slate-900">
                                {m.name}
                              </p>
                              <p className="mt-0.5 text-[0.8125rem] leading-5 text-slate-500">
                                {m.blurb}
                              </p>
                            </div>

                            {modules[m.id] ? (
                              /*
                                A window onto the real card at 62%. The height
                                is fixed so every entry is the same size — a
                                preview that grew with its module would make
                                the library a page about the tallest one.
                              */
                              <div
                                aria-hidden="true"
                                className="module-preview mt-3 h-40 min-w-0 overflow-hidden rounded-xl border border-[color:var(--glass-edge)]"
                              >
                                <div className="module-preview-inner">{modules[m.id]}</div>
                              </div>
                            ) : null}

                            <button
                              type="button"
                              disabled={placed}
                              onClick={() => {
                                onAdd(m.id);
                                onClose();
                              }}
                              className={`mt-3 w-full !min-h-9 text-[0.875rem] ${
                                placed ? "btn-secondary" : "btn-primary"
                              }`}
                            >
                              {placed ? "On the board" : "Add to board"}
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--glass-edge)] pt-3">
                <p className="text-[0.8125rem] leading-5 text-slate-500">
                  Drag a card on the board to move it, or remove one with the − in its corner.
                </p>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={onReset} className="btn-secondary !min-h-9 text-[0.875rem]">
                    Reset
                  </button>
                  <button type="button" onClick={onClose} className="btn-primary !min-h-9 text-[0.875rem]">
                    Done
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
