"use client";

import { useRef, useState, type PointerEvent } from "react";

/*
  The shared behaviour behind every option-choosing bar in the app: the
  theme control, the organisation sections, the notification filter.

  All three had grown the same code independently — a `dragging` ref, a
  `dragIndex` ref, a `previewIndex` state, an `indexAtPointer` that floors a
  fraction of the width, and five pointer handlers that have to agree about
  which one commits and which one only previews. Three copies of a thing
  this fiddly is three chances to fix a bug in one place and leave it in the
  other two, which is exactly what happened: the theme control learned to
  track the finger continuously and to say when it was being pressed, and
  the other two carried on jumping between whole stops.

  So it lives here once. What a caller supplies is how many stops there are
  and what to do when one is chosen; what it gets back is the state the CSS
  needs and the handlers to spread onto the track.
*/

export type SegmentedDrag = {
  /** The stop under the pointer, or null when nothing is being previewed. */
  previewIndex: number | null;
  /** True only while the pointer is actually down — see `pressed` below. */
  pressed: boolean;
  /**
   * Where the knob is, in stop units, as a fraction while dragging.
   *
   * Whole stops are jumps; a fraction is a knob that follows the finger,
   * and a lens that moves continuously has something new to bend on every
   * frame. Falls back to whole stops the moment the finger lifts, so the
   * knob settles onto the choice rather than staying wherever it was let
   * go.
   */
  position: number;
  /** Preview a stop without committing — for hover and keyboard focus. */
  preview: (index: number | null) => void;
  /** Spread onto the track element. */
  handlers: {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerCancel: () => void;
    onPointerLeave: () => void;
  };
};

export function useSegmentedDrag({
  count,
  selectedIndex,
  onCommit,
}: {
  count: number;
  /** Where the knob rests when nothing is being previewed or dragged. */
  selectedIndex: number;
  onCommit: (index: number) => void;
}): SegmentedDrag {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  /*
    Deliberately separate from `previewIndex`, which hover and keyboard
    focus also set. A pointer resting over the control is not a press, and
    the knob's bloom and its turn to clear glass are answering the press.
  */
  const [pressed, setPressed] = useState(false);
  const [dragPosition, setDragPosition] = useState<number | null>(null);
  const dragging = useRef(false);
  const dragIndex = useRef<number | null>(null);

  const visibleIndex = previewIndex ?? Math.max(0, selectedIndex);
  const position = dragPosition ?? visibleIndex;

  /*
    The pointer's position in stop units. Half a stop is subtracted because
    the knob is placed by its leading edge while the pointer aims at its
    middle, and it is clamped so the knob never travels past either end.
  */
  const positionAtPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const raw = ((event.clientX - rect.left) / rect.width) * count - 0.5;
    return Math.max(0, Math.min(count - 1, raw));
  };

  const trackPointer = (event: PointerEvent<HTMLDivElement>) => {
    const next = positionAtPointer(event);
    /* Rounded, not floored: the stop the knob looks nearest to is the one a
       release has to commit, and flooring commits the one to its left for
       most of the knob's own width. */
    const index = Math.round(next);
    dragIndex.current = index;
    setDragPosition(next);
    setPreviewIndex(index);
  };

  const end = () => {
    dragging.current = false;
    setPressed(false);
    setDragPosition(null);
    dragIndex.current = null;
    setPreviewIndex(null);
  };

  return {
    previewIndex,
    pressed,
    position,
    preview: setPreviewIndex,
    handlers: {
      onPointerDown: (event) => {
        dragging.current = true;
        setPressed(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        trackPointer(event);
      },
      onPointerMove: (event) => {
        if (dragging.current) trackPointer(event);
      },
      onPointerUp: (event) => {
        if (!dragging.current) return;
        trackPointer(event);
        const index = dragIndex.current;
        event.currentTarget.releasePointerCapture(event.pointerId);
        end();
        if (index !== null) onCommit(index);
      },
      onPointerCancel: end,
      onPointerLeave: () => {
        if (!dragging.current) setPreviewIndex(null);
      },
    },
  };
}
