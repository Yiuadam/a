"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

/*
  Passage on the left, questions on the right, a bar between them you can drag.

  This is the layout candidates name first when they say why the computer test
  is easier than the paper one: both halves visible at once, each scrolling on
  its own, no flipping back and forth. Reproducing it means two things that are
  easy to get wrong.

  The panes scroll *independently*. Two overflow containers side by side, not
  one page with two columns — so finding your place in the passage does not
  move the questions, and reading question 14 does not lose paragraph C.

  The divider is draggable, because the right split is not the same for
  everyone or for every question type. Matching headings wants more passage;
  a long note-completion table wants more questions.

  Below `lg` this renders nothing of its own: the reading page keeps its
  horizontally swipeable panes, which is the right shape on a phone and is not
  something the real exam has to solve because the real exam is not on a phone.
*/

const MIN = 25;
const MAX = 75;

/*
  Whether the split is on at all, answered in JavaScript rather than in CSS.

  The obvious thing is to render both arrangements and hide one with a media
  query, and it is wrong here: both would be in the DOM, so every question
  would exist twice — two inputs sharing a name, two elements answering to the
  same data-question-id, and a palette that scrolls to whichever the browser
  found first. One instance, chosen at runtime.

  useSyncExternalStore rather than an effect, so the first paint is already
  correct instead of being the mobile layout for a frame.
*/
const WIDE = "(min-width: 1024px)";

function subscribeWide(onChange: () => void): () => void {
  const mq = window.matchMedia(WIDE);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export function useIsWide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE).matches,
    /* The server has no width; the phone layout is the safer first paint. */
    () => false,
  );
}

export default function SplitPanes({
  left,
  right,
  initial = 55,
  className = "",
}: {
  left: ReactNode;
  right: ReactNode;
  /** Percentage of the width given to the left pane. */
  initial?: number;
  className?: string;
}) {
  const [split, setSplit] = useState(initial);
  const frame = useRef<HTMLDivElement | null>(null);
  const draggingPointer = useRef<number | null>(null);
  const previousUserSelect = useRef("");

  const moveTo = useCallback((clientX: number) => {
    const box = frame.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const pct = ((clientX - box.left) / box.width) * 100;
    setSplit(Math.min(MAX, Math.max(MIN, pct)));
  }, []);

  const stopDrag = useCallback(() => {
    if (draggingPointer.current === null) return;
    draggingPointer.current = null;
    document.body.style.userSelect = previousUserSelect.current;
  }, []);

  /* Pointer capture keeps the drag alive outside the narrow divider without
     leaving window listeners behind if the component unmounts mid-gesture. */
  const startDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingPointer.current = event.pointerId;
    previousUserSelect.current = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    moveTo(event.clientX);
  }, [moveTo]);

  const continueDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (draggingPointer.current === event.pointerId) moveTo(event.clientX);
  }, [moveTo]);

  const finishDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (draggingPointer.current !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    stopDrag();
  }, [stopDrag]);

  useEffect(() => {
    /* Pointer capture is the primary path, but a browser can cancel capture
       while a tab loses focus or while native drag handling takes over. These
       listeners are installed once with the component and always removed, so
       every release path restores text selection without creating the zombie
       listeners the old per-drag implementation could leave behind. */
    const finish = () => stopDrag();
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("mouseup", finish);
    window.addEventListener("blur", finish);
    return () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("mouseup", finish);
      window.removeEventListener("blur", finish);
      stopDrag();
    };
  }, [stopDrag]);

  return (
    <div ref={frame} className={`flex min-h-0 items-stretch ${className}`}>
      <div className="exam-pane min-w-0 overflow-y-auto rounded-2xl p-3" style={{ width: `${split}%` }}>
        {left}
      </div>

      {/*
        A separator with a role and keyboard handling, because a drag-only
        control is a control some people cannot use. Arrow keys move it five
        per cent at a time, which is enough to be useful and coarse enough to
        stay predictable.
      */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the passage and questions"
        aria-valuenow={Math.round(split)}
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        tabIndex={0}
        onPointerDown={startDrag}
        onPointerMove={continueDrag}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={stopDrag}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setSplit((v) => Math.max(MIN, v - 5));
          if (e.key === "ArrowRight") setSplit((v) => Math.min(MAX, v + 5));
        }}
        className="group relative w-2 shrink-0 cursor-col-resize focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--exam-accent)]"
      >
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[color:var(--exam-line)] transition-colors group-hover:bg-[color:var(--exam-fg)]" />
        {/* A grip, so the bar reads as draggable before anybody tries. */}
        <div className="absolute left-1/2 top-1/2 h-8 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[color:var(--exam-line)] transition-colors group-hover:bg-[color:var(--exam-fg)]" />
      </div>

      <div className="exam-pane min-w-0 flex-1 overflow-y-auto rounded-2xl p-3">{right}</div>
    </div>
  );
}
