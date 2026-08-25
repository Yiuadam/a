"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type UIEvent } from "react";

export type SwipePanel = {
  label: string;
  content: ReactNode;
};

/**
 * A narrow-screen workspace: one panel is readable, the next one peeks in.
 * The same track supports a swipe, clicking the visible edge, or choosing the
 * labelled control above it.
 */
export default function SwipePanels({
  panels,
  resetScrollKey,
}: {
  panels: SwipePanel[];
  /**
   * Change this (e.g. from `submitted`/`grade` becoming truthy) to scroll
   * every panel back to its own top. Each panel scrolls independently, so
   * finishing a paper otherwise leaves whichever one holds the questions
   * wherever the last answer was, with nothing pointing back at the score.
   */
  resetScrollKey?: unknown;
}) {
  const track = useRef<HTMLDivElement | null>(null);
  const panelRefs = useRef<Array<HTMLElement | null>>([]);
  const [active, setActive] = useState(0);
  const [preview, setPreview] = useState<number | null>(null);
  const visible = preview ?? active;

  useEffect(() => {
    for (const panel of panelRefs.current) panel?.scrollTo({ top: 0 });
  }, [resetScrollKey]);

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
        className="no-scrollbar flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto px-4"
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
            className="card w-[calc(100%-2rem)] shrink-0 snap-center overflow-y-auto !p-3 sm:w-[calc(100%-4rem)] sm:!p-4"
          >
            {panel.content}
          </section>
        ))}
      </div>
    </div>
  );
}
