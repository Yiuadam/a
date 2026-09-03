"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import ModuleLibrary from "@/components/dashboard/ModuleLibrary";
import {
  DEFAULT_LAYOUT,
  MODULE_LIBRARY,
  getLayout,
  getServerLayout,
  reorder,
  setLayout,
  subscribeLayout,
  type ModuleId,
} from "@/lib/dashboard/layout";

/*
  The dashboard, arranged by the person looking at it.

  Two modes and one grid. Ordinarily the board just draws the chosen modules;
  in edit mode each one grows a handle and a remove button and can be dragged
  onto another to swap places, and the library opens beside it.

  ---------------------------------------------------------------------------
  Why the modules are passed in rather than imported here

  A module's content belongs to the page that has the data — the plan needs the
  profile, the score needs the results, the tiles need the entitlement checks.
  Importing them here would mean this component fetching all of it on behalf of
  things it does not otherwise know about. So the page renders each module and
  hands them over by id; this component owns arrangement and nothing else.

  ---------------------------------------------------------------------------
  Drag, and the keyboard that has to do the same thing

  HTML5 drag events rather than a library: this is one grid of at most seven
  cards, and pointer-move maths would be a great deal more code for the same
  result.

  A drag has no keyboard, so in edit mode each card is focusable and the arrow
  keys move it — the same operation a drop performs, not a lesser one. This
  started as a pair of visible ‹ › buttons on every card; the owner asked for
  only the delete button, and three controls in a corner was indeed a lot of
  furniture on a card whose content is the point. The keys stayed. Dropping
  them as well would have made rearranging the page impossible without a mouse,
  which is a different thing from making it tidier.
*/

export default function Board({ modules }: { modules: Partial<Record<ModuleId, ReactNode>> }) {
  const layout = useSyncExternalStore(subscribeLayout, getLayout, getServerLayout);
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState<ModuleId | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [over, setOver] = useState<ModuleId | null>(null);

  /* A module the page had no data for draws nothing, and an empty card is
     worse than an absent one — so it is skipped here rather than rendered
     hollow. It stays in the layout, because the data may come back. */
  const shown = layout.filter((id) => modules[id]);

  const move = (from: ModuleId, to: ModuleId) => setLayout(reorder(layout, from, to));
  const nudge = (id: ModuleId, by: -1 | 1) => {
    const at = shown.indexOf(id);
    const target = shown[at + by];
    if (target) move(id, target);
  };

  return (
    <div className="min-w-0">
      {/*
        One row, at the owner's ask. Edit board, then Add module / Reset / Done
        in the same place rather than a button above the grid and two more
        underneath it — three controls for one task, in three parts of the page,
        is a task that looks like three.
      */}
      <div className="mb-2.5 flex flex-wrap items-center justify-end gap-2">
        {editing && (
          <>
            <button
              type="button"
              onClick={() => setLibraryOpen(true)}
              className="btn-secondary !min-h-8 !px-3 text-[0.8125rem]"
            >
              Add a module
            </button>
            <button
              type="button"
              onClick={() => setLayout(DEFAULT_LAYOUT)}
              className="btn-secondary !min-h-8 !px-3 text-[0.8125rem]"
            >
              Reset
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => {
            setEditing((on) => !on);
            setLibraryOpen(false);
          }}
          className={`!min-h-8 !px-3 text-[0.8125rem] ${editing ? "btn-primary" : "btn-secondary"}`}
          aria-pressed={editing}
        >
          {editing ? "Done" : "Edit board"}
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
        {shown.map((id) => {
          const meta = MODULE_LIBRARY.find((m) => m.id === id);
          return (
            <div
              key={id}
              draggable={editing}
              onDragStart={() => setDragging(id)}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onDragOver={(event) => {
                if (!editing || !dragging || dragging === id) return;
                /* Without this the drop is refused and the card springs back. */
                event.preventDefault();
                setOver(id);
              }}
              onDragLeave={() => setOver((current) => (current === id ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging) move(dragging, id);
                setDragging(null);
                setOver(null);
              }}
              tabIndex={editing ? 0 : undefined}
              role={editing ? "listitem" : undefined}
              aria-label={editing ? `${meta?.name ?? id}. Use the arrow keys to move it.` : undefined}
              onKeyDown={(event) => {
                if (!editing) return;
                if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                  event.preventDefault();
                  nudge(id, -1);
                } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                  event.preventDefault();
                  nudge(id, 1);
                }
              }}
              className={`relative min-w-0 transition-opacity ${editing ? "cursor-grab active:cursor-grabbing" : ""} ${
                dragging === id ? "opacity-40" : ""
              } ${over === id ? "dashboard-module-target" : ""}`}
            >
              {editing && (
                <button
                  type="button"
                  onClick={() => setLayout(layout.filter((other) => other !== id))}
                  aria-label={`Remove ${meta?.name ?? id} from the board`}
                  /*
                    Its own class rather than .btn-secondary, and that is not a
                    style preference: `@utility btn` applies `relative`, which
                    beats an `absolute` utility of the same weight, so this
                    button sat in the card's flow at the top left instead of in
                    the corner. Fighting that with `!absolute` would have left
                    the next person to read it wondering why.
                  */
                  className="dashboard-module-remove"
                >
                  {/*
                    A minus, not a cross. A cross reads as "close this" — the
                    thing itself is going away — and removing a module does not
                    destroy anything: it goes back to the library and can be
                    added again. A minus is what every edit-mode grid on this
                    platform uses for exactly that reason.
                  */}
                  <svg viewBox="0 0 20 20" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M5 10h10" />
                  </svg>
                </button>
              )}
              {modules[id]}
            </div>
          );
        })}
      </div>

      {editing && (
        <ModuleLibrary
          layout={layout}
          modules={modules}
          onAdd={(id) => setLayout([...layout, id])}
          onReset={() => setLayout(DEFAULT_LAYOUT)}
          onClose={() => setLibraryOpen(false)}
          open={libraryOpen}
        />
      )}

    </div>
  );
}
