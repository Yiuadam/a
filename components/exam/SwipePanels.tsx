"use client";

import { useRef, useState, type CSSProperties, type ReactNode, type UIEvent } from "react";

export type SwipePanel = {
  label: string;
  content: ReactNode;
};

/**
 * A narrow-screen workspace: one panel is readable, the next one peeks in.
 * The same track supports a swipe, clicking the visible edge, or choosing the
 * labelled control above it.
 *
 * How wide the peek is, and why it is now a sliver on a phone
 *
 * The track's gutter and the width the panel gave back to show its neighbour
 * used to take 68px of a 390px screen between them, and they were two ways of
 * buying the same thing. That is a sixth of the width spent advertising a
 * gesture the labelled control above already offers by name — and it was being
 * spent on the one screen that could least afford it, the reading paper, where
 * what was left wrapped a question into four-word lines.
 *
 * So on a phone the peek is cut to a sliver rather than removed. The panel is
 * still visibly not the whole track, which is what tells somebody there is
 * another one; the control above is what they actually press. From `sm` up the
 * old proportions stand, because there the width was never the constraint.
 */
export default function SwipePanels({ panels }: { panels: SwipePanel[] }) {
  const track = useRef<HTMLDivElement | null>(null);
  const panelRefs = useRef<Array<HTMLElement | null>>([]);
  const [active, setActive] = useState(0);
  const [preview, setPreview] = useState<number | null>(null);
  const visible = preview ?? active;

  const show = (index: number) => {
    setActive(index);
    panelRefs.current[index]?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    });
  };

  const updateActive = (event: UIEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const centre = box.left + box.width / 2;
    let nearest = active;
    let distance = Number.POSITIVE_INFINITY;
    panelRefs.current.forEach((panel, index) => {
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      const next = Math.abs(rect.left + rect.width / 2 - centre);
      if (next < distance) {
        distance = next;
        nearest = index;
      }
    });
    if (nearest !== active) setActive(nearest);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1.5 flex shrink-0 justify-center">
        <div
          className="panel-toggle-base relative grid w-full max-w-72 rounded-xl p-0.5"
          role="tablist"
          aria-label="Workspace panels"
          onPointerLeave={() => setPreview(null)}
          style={
            {
              gridTemplateColumns: `repeat(${panels.length}, minmax(0, 1fr))`,
              "--panel-index": visible,
              "--panel-count": panels.length,
            } as CSSProperties
          }
        >
          <span className="panel-toggle-selector" aria-hidden="true" />
          {panels.map((panel, index) => (
            <button
              key={panel.label}
              type="button"
              role="tab"
              aria-selected={active === index}
              onPointerEnter={() => setPreview(index)}
              onFocus={() => setPreview(index)}
              onBlur={() => setPreview(null)}
              onClick={() => show(index)}
              className={`relative z-10 min-w-0 truncate rounded-lg px-2 py-1 text-[11px] font-medium transition-colors ${
                visible === index
                  ? "text-[color:var(--exam-fg)]"
                  : "text-[color:var(--exam-muted)]"
              }`}
            >
              {panel.label}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={track}
        onScroll={updateActive}
        /*
          No gutter of its own on a phone. The panel is snapped to the centre
          of this track and is narrower than it, so the space either side of it
          is already the peek — a gutter on top of that is the same allowance
          charged twice. It was the difference between a three-option answer
          row fitting on one line and wrapping onto two.
        */
        className="no-scrollbar flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto px-0 sm:px-4"
      >
        {panels.map((panel, index) => (
          <section
            key={panel.label}
            ref={(node) => {
              panelRefs.current[index] = node;
            }}
            role="tabpanel"
            aria-label={panel.label}
            onClick={() => {
              if (active !== index) show(index);
            }}
            /*
              The inline inset is set in app/globals.css against
              `.exam-swipe-panel`, not here. An important padding utility loses
              to the base-layer card rail under CSS's reversed important layer
              order, so the `!p-3` this used to carry was never the padding it
              got — it asked for 12px on each side and was quietly given 25.5px.
              Only the block padding is a utility now, because only the block
              padding was ever doing what it said.
            */
            className="exam-swipe-panel card w-[calc(100%-0.75rem)] shrink-0 snap-center overflow-y-auto !py-3 sm:w-[calc(100%-4rem)] sm:!py-4"
          >
            {panel.content}
          </section>
        ))}
      </div>
    </div>
  );
}
