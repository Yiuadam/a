"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MAX_MODULES, MODULE_GROUPS, MODULE_LIBRARY, boardIsFull, type ModuleId } from "@/lib/dashboard/layout";

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
  onClose,
}: {
  layout: readonly ModuleId[];
  modules: Partial<Record<ModuleId, ReactNode>>;
  onAdd: (id: ModuleId) => void;
  onReset: () => void;
  open: boolean;
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
  const full = boardIsFull(layout);
  const needle = query.trim().toLowerCase();
  const listed = MODULE_LIBRARY.filter(
    (m) =>
      /*
        Only what the page can actually draw. A module with no node here is one
        this page has no data for, and listing it would offer something that
        adds a row to the layout and nothing to the board — the worst kind of
        broken, because it looks like it worked.
      */
      modules[m.id] !== undefined &&
      /*
        A module on the board is not in the library. It was listed and greyed,
        on the theory that a learner might look for what they had just added —
        but the board is right there, and a greyed row for every module already
        placed leaves the library mostly full of things that cannot be chosen.
        The owner asked for them gone and the page answers the question anyway.
      */
      !layout.includes(m.id) &&
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
              /*
                A large sheet, because the point of it is the previews and a
                preview too small to read is a swatch. It takes most of the
                window on purpose — 92% of the width up to 84rem, 88% of the
                height — which at 1728px is roughly three times the area the
                first version had.
              */
              className="card liquid-glass module-library-panel relative max-h-[88dvh] w-[min(92vw,84rem)] overflow-y-auto !p-6"
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
                    {full
                      ? `Your board holds ${MAX_MODULES}, which is what one screen shows. Remove one with the − in its corner to make room.`
                      : "Each one is shown as it will appear. Tap it to add it, then drag it where you want it."}
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
                    {query.trim() === ""
                      ? "Every module is on your board. Remove one with the − in its corner to see it here again."
                      : `Nothing matches “${query}”.`}
                  </p>
                ) : (
                  <ul className="grid min-w-0 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                    {listed.map((m) => {
                      return (
                        <li key={m.id} className="min-w-0">
                          {/*
                            The whole tile is the control. A preview with an
                            "Add to board" button under it asks twice for one
                            decision — the thing being pointed at is the thing
                            being chosen, and a separate button only adds a
                            place to miss.

                            A module already on the board stays listed and
                            stops being a button. Removing it from the list
                            would make somebody hunt for what they just added
                            to check that they added it.
                          */}
                          <button
                            type="button"
                            disabled={full}
                            aria-label={
                              full
                                ? `Your board is full. Remove a module to add ${m.name}.`
                                : `Add ${m.name} to your board`
                            }
                            onClick={() => {
                              onAdd(m.id);
                              onClose();
                            }}
                            /*
                              The module and its name, and nothing else.

                              This used to be a bordered card carrying a title,
                              a sentence of description and a preview — a frame
                              around a frame, with prose explaining a thing that
                              was already on screen. The preview is the
                              description; a short word underneath says which
                              one it is, the way every control library does it.
                            */
                            className={`module-library-tile flex w-full min-w-0 flex-col items-center gap-2 rounded-2xl p-1.5 text-center transition-colors ${
                              full ? "cursor-default opacity-45" : "active:translate-y-px"
                            }`}
                          >
                            {(
                              /*
                                A window onto the real card at 62%. The height
                                is fixed so every entry is the same size — a
                                preview that grew with its module would make
                                the library a page about the tallest one.
                              */
                              <span
                                aria-hidden="true"
                                className="module-preview block h-56 w-full min-w-0 overflow-hidden"
                              >
                                <span className="module-preview-inner block">{modules[m.id]}</span>
                              </span>
                            )}
                            <span className="text-[0.9375rem] font-medium text-slate-700">
                              {m.short}
                            </span>
                          </button>
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
