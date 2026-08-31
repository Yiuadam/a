"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";

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
  /**
   * How hard the knob is being thrown, from 0 (still) to 1 (flung).
   *
   * Drives the squash: a knob that is moving stretches along the direction
   * it is moving in and thins across it, then rounds back out when it
   * stops. Solved from the pointer's own speed rather than from a
   * start/stop flag, so a slow deliberate drag barely deforms and a flick
   * deforms fully — the deformation reads as weight, and weight you cannot
   * vary is just an animation playing.
   */
  squash: number;
  /**
   * True while a tapped knob is travelling to the stop it was sent to.
   *
   * A tap is not a drag: nothing is under the finger to follow, so the knob
   * has to make the journey itself. It stays lifted and deformed for the
   * length of that journey and settles at the end of it, which is what
   * makes it read as being drawn to the icon rather than teleporting onto
   * it.
   */
  settling: boolean;
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
  const [squash, setSquash] = useState(0);
  const [settling, setSettling] = useState(false);
  const dragging = useRef(false);
  /*
    Whether this gesture has become a drag yet. A press alone must not move
    the knob: if it jumps to the finger on pointerdown then a tap teleports
    it, and the travel a tap is supposed to make never happens.
  */
  const moved = useRef(false);
  const downPosition = useRef<number | null>(null);
  const dragIndex = useRef<number | null>(null);
  const settleTravel = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* The previous sample, for the speed the squash is solved from. */
  const lastMove = useRef<{ position: number; at: number } | null>(null);
  /* pointermove stops firing the instant a finger holds still, so nothing
     would ever tell the knob it had come to rest. This does. */
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelSettle = () => {
    if (settleTimer.current !== null) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
  };

  const cancelTravel = () => {
    if (settleTravel.current !== null) {
      clearTimeout(settleTravel.current);
      settleTravel.current = null;
    }
  };

  useEffect(
    () => () => {
      cancelSettle();
      cancelTravel();
    },
    [],
  );

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

  /*
    Speed, in stops per second, turned into a 0..1 squash.

    SQUASH_FULL_SPEED is where the deformation saturates: four stops a
    second, which is a genuine flick rather than an ordinary drag. Anything
    faster is already at full stretch, so no gesture can tear the knob into
    a sliver. Set at 2.5 first and measured against a driven drag, where it
    sat pinned at 1 for nearly every sample — a squash that is always full
    is a shape change, not a response to speed.
  */
  const SQUASH_FULL_SPEED = 4;
  const sampleSpeed = (position: number) => {
    /* performance.now, not Date.now: this is an elapsed-time measurement,
       and it should not be affected by the wall clock being adjusted. */
    const at = typeof performance === "undefined" ? 0 : performance.now();
    const previous = lastMove.current;
    lastMove.current = { position, at };
    if (!previous) return;
    const elapsed = at - previous.at;
    /* Two moves inside the same millisecond divide by zero, and the first
       move after a pause has a long elapsed time that would read as almost
       no speed at all — neither says anything about how fast the finger is
       going. */
    if (elapsed <= 0 || elapsed > 120) return;
    const speed = (Math.abs(position - previous.position) / elapsed) * 1000;
    setSquash(Math.min(1, speed / SQUASH_FULL_SPEED));

    /* Held still for longer than a couple of frames, and it has stopped —
       round it back out. The spring itself is the CSS transition. */
    cancelSettle();
    settleTimer.current = setTimeout(() => setSquash(0), 90);
  };

  const trackPointer = (event: PointerEvent<HTMLDivElement>) => {
    const next = positionAtPointer(event);
    sampleSpeed(next);
    /* Rounded, not floored: the stop the knob looks nearest to is the one a
       release has to commit, and flooring commits the one to its left for
       most of the knob's own width. */
    const index = Math.round(next);
    dragIndex.current = index;
    setDragPosition(next);
    setPreviewIndex(index);
  };

  /*
    How far the finger has to travel before the gesture counts as a drag, in
    stop units. Small enough that a deliberate drag is never mistaken for a
    tap, large enough that the shake in an ordinary tap is.
  */
  const DRAG_THRESHOLD = 0.06;
  /* Matches the knob's own glide in globals.css. */
  const TRAVEL_MS = 440;
  /* And its width/height easing, which is what the reform actually runs on. */
  const REFORM_MS = 200;

  /*
    Send the knob to a stop it is not on, as a thrown drop of water rather
    than a jump: lifted and stretched along the way, round again on
    arrival.

    The deformation is a single value held for the length of the journey,
    not a curve traced by hand. It does not need to be one — CSS is already
    easing the width and height into it and out of it on an overshooting
    curve, so a square input comes out as a stretch that grows, holds and
    then springs back past round before settling. Further stops mean a
    faster journey over the same duration, so the stretch scales with the
    distance.
  */
  const travelTo = (index: number) => {
    const distance = Math.abs(index - (dragPosition ?? Math.max(0, selectedIndex)));
    if (distance < 0.5) return;
    cancelTravel();
    setSettling(true);
    setSquash(Math.min(1, 0.4 + distance * 0.3));

    /*
      The stretch is released before the knob lands, not when it lands.
      Returning to round is itself a 200ms eased change, so releasing it on
      arrival means the knob is still reforming well after it has stopped —
      it arrives as an oval and rounds out afterwards, which reads as two
      events rather than one. Released at REFORM_MS before the end, the
      reform finishes as the travel does.
    */
    settleTravel.current = setTimeout(() => {
      setSquash(0);
      /*
        And the lifted state outlasts the travel by the same amount. The
        squash lives on the pressed rule, so dropping `pressed` the instant
        the knob lands would take the shape change away mid-reform and snap
        it round.
      */
      settleTravel.current = setTimeout(() => {
        setSettling(false);
        settleTravel.current = null;
      }, REFORM_MS * 2);
    }, TRAVEL_MS - REFORM_MS);
  };

  const end = () => {
    dragging.current = false;
    moved.current = false;
    downPosition.current = null;
    setPressed(false);
    setDragPosition(null);
    dragIndex.current = null;
    setPreviewIndex(null);
    /* Letting go is a stop, however fast it was travelling a frame ago. */
    cancelSettle();
    lastMove.current = null;
    setSquash(0);
  };

  return {
    previewIndex,
    /* A settling knob is still lifted: it has not arrived yet, and dropping
       the bloom mid-flight would make it shrink away from the icon it is
       being drawn to. */
    pressed: pressed || settling,
    position,
    squash,
    settling,
    preview: setPreviewIndex,
    handlers: {
      onPointerDown: (event) => {
        dragging.current = true;
        moved.current = false;
        setPressed(true);
        cancelTravel();
        setSettling(false);
        /* A press is not a move. Starting from no history means the first
           pointermove has nothing to measure against and leaves the knob
           round, so touching it does not make it flinch. */
        lastMove.current = null;
        downPosition.current = positionAtPointer(event);
        event.currentTarget.setPointerCapture(event.pointerId);
        /* Deliberately not tracking yet. Moving the knob here is what made
           a tap teleport it under the finger, which left nothing for the
           travel to animate. */
      },
      onPointerMove: (event) => {
        if (!dragging.current) return;
        if (!moved.current) {
          const from = downPosition.current;
          if (from !== null && Math.abs(positionAtPointer(event) - from) < DRAG_THRESHOLD) return;
          moved.current = true;
        }
        trackPointer(event);
      },
      onPointerUp: (event) => {
        if (!dragging.current) return;
        const dragged = moved.current;
        const index = dragged ? dragIndex.current : Math.round(positionAtPointer(event));
        event.currentTarget.releasePointerCapture(event.pointerId);
        /* Read the target before `end` clears the gesture's state, and
           start the travel after it, so the knob is already back on whole
           stops when it begins moving. A dragged knob is by definition
           already where it was put, so only a tap travels. */
        end();
        if (index === null) return;
        if (!dragged) travelTo(index);
        onCommit(index);
      },
      onPointerCancel: end,
      onPointerLeave: () => {
        if (!dragging.current) setPreviewIndex(null);
      },
    },
  };
}
