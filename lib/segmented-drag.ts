"use client";

import { useEffect, useRef, useState } from "react";

/*
  The shared behaviour behind every option-choosing bar in the app: the
  theme control, the organisation sections, the notification filter.

  All three had grown the same code independently — a `dragging` ref, a
  `dragIndex` ref, a `previewIndex` state, an `indexAtPointer` that floors a
  fraction of the width, and five pointer handlers that have to agree about
  which one commits and which one only previews. Three copies of a thing
  this fiddly is three chances to fix a bug in one place and leave it in the
  other two, which is exactly what happened. So it lives here once.

  What it answers now is hover. A pointer arriving anywhere over the bar
  lifts the knob — the bloom, the turn to clear glass, the lens — and moving
  from one option to another throws it across, deformed like water for the
  length of the journey. Those two things used to answer a press, and the
  press used to carry the knob under the finger frame by frame.

  That drag is gone, deliberately. It was the only gesture in the app that
  owned a finger for as long as it was down, which cost the bar its share of
  the page's scrolling, and what it bought was a knob that could be put
  somewhere the pointer was not going to choose anyway — every one of these
  bars commits on the option's own click. Nothing here follows a pointer
  continuously any more; the knob only ever stands on a whole stop, and CSS
  moves it between them.

  Which leaves touch, where there is no hover to answer at all. It gets the
  same treatment for free: a tap fires pointerenter on its way in, so the
  knob lifts and makes the journey before the click that commits it.
*/

export type SegmentedDrag = {
  /** The stop under the pointer, or null when nothing is being previewed. */
  previewIndex: number | null;
  /**
   * True while a pointer is over the bar, and for as long afterwards as a
   * knob it threw is still in the air.
   *
   * The bloom, the clear glass and the lens all hang off this. It is not
   * the same thing as `previewIndex`, which keyboard focus also sets and
   * which is still null while a pointer rests on the rail between options:
   * the knob has to lift the moment the pointer is over the bar, before it
   * has reached anything to preview.
   */
  pressed: boolean;
  /**
   * Where the knob is, in stop units.
   *
   * Always a whole stop. It was a fraction while a finger could carry the
   * knob about; now the only journeys are between stops, and each one is a
   * CSS transition rather than a value pushed a frame at a time.
   */
  position: number;
  /**
   * How hard the knob has been thrown, from 0 (still) to 1 (flung).
   *
   * Drives the squash: a knob in flight stretches along the direction it is
   * travelling and thins across it, then rounds back out as it lands. It is
   * scaled by the distance, so crossing a five-stop bar deforms it more
   * than stepping to the neighbour — the deformation reads as weight, and
   * weight you cannot vary is just an animation playing.
   */
  squash: number;
  /**
   * True while the knob is travelling to the stop it was sent to.
   *
   * Nothing is under the pointer for it to follow, so the knob has to make
   * the journey itself. It stays lifted and deformed for the length of that
   * journey and settles at the end of it, which is what makes it read as
   * being drawn to the option rather than teleporting onto it.
   */
  settling: boolean;
  /** Send the knob to a stop — for hover and keyboard focus. */
  preview: (index: number | null) => void;
  /** Spread onto the track element. */
  handlers: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    onPointerCancel: () => void;
  };
};

export function useSegmentedDrag({
  selectedIndex,
}: {
  /** Where the knob rests when nothing is being previewed. */
  selectedIndex: number;
}): SegmentedDrag {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [hovering, setHovering] = useState(false);
  const [squash, setSquash] = useState(0);
  const [settling, setSettling] = useState(false);
  const settleTravel = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelTravel = () => {
    if (settleTravel.current !== null) {
      clearTimeout(settleTravel.current);
      settleTravel.current = null;
    }
  };

  useEffect(() => cancelTravel, []);

  const position = previewIndex ?? Math.max(0, selectedIndex);

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
    /* Whole stops are the only positions there are, so this is really "the
       knob is already here" — there is no journey to animate, and starting
       one would deform it on the spot. */
    const distance = Math.abs(index - position);
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

  const leave = () => {
    setHovering(false);
    setPreviewIndex(null);
    /*
      A travel already in flight is deliberately left alone — no cancel, and
      the squash is not cleared here. Touch depends on it: a tap sends
      pointerleave before the click that commits, so cutting the journey
      short there would leave the one kind of device that cannot hover with
      no effect at all. On a mouse this is what turns the knob around, since
      the position it is flying to becomes the selected stop again.
    */
  };

  return {
    previewIndex,
    /* A settling knob is still lifted: it has not arrived yet, and dropping
       the bloom mid-flight would make it shrink away from the option it is
       being drawn to. It is also what keeps the whole effect on touch,
       where the pointer has already left by the time the click lands. */
    pressed: hovering || settling,
    position,
    squash,
    settling,
    preview: (index) => {
      setPreviewIndex(index);
      /*
        Null is a clear rather than a destination — the option was left, or
        focus went elsewhere — and where the knob goes home to is decided by
        the render that follows, not from here. A commit is one of those
        clears, and the caller has already committed by this point: reading
        the selected stop here would read the one before it.
      */
      if (index !== null) travelTo(index);
    },
    handlers: {
      onPointerEnter: () => setHovering(true),
      onPointerLeave: leave,
      /* A touch that becomes a page scroll is cancelled rather than lifted,
         and not every engine follows that with a pointerleave. Without this
         the knob would stay lifted with nothing over it. */
      onPointerCancel: leave,
    },
  };
}
