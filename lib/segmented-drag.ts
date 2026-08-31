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

  So it lives here once. What a caller supplies is how many stops there are,
  where the knob rests, and what to do when a stop is chosen; what it gets
  back is the state the CSS needs and the handlers to spread onto the track.

  Two gestures reach the same knob, and they answer different questions.

  Hover asks "which of these am I about to pick?". A pointer anywhere over
  the bar lifts the knob — the bloom, the turn to clear glass, the lens —
  and moving from one option to another throws it across, deformed like
  water for the length of the journey. Nothing is under the pointer for the
  knob to follow, so it makes the journey itself, and the deformation is
  scaled by how far it has to go.

  Dragging says "put it there". The knob comes under the finger and stays
  there frame by frame, and the deformation is solved from the pointer's own
  speed instead — which is the one thing a pointer carrying the knob can say
  and a pointer merely naming a stop cannot.

  These were built one after the other and each time only one survived: the
  drag was taken out so hover could have the effect, and hover kept it. Both
  are wanted, so both are here. The rule between them is that a finger that
  is down owns the knob — `preview` returns early for as long as a gesture
  is running, so hover and keyboard focus can never push the position out
  from under a drag.

  Which leaves touch, where there is no hover at all. It gets the effect for
  free: a tap fires pointerenter on its way in, so the knob lifts and makes
  the journey before the click that commits it. And leaving must not cancel
  a travel already in flight, because pointerleave arrives *before* that
  click — cancelling there would strip the whole effect from the one class
  of device that cannot hover.
*/

export type SegmentedDrag = {
  /** The stop under the pointer, or null when nothing is being previewed. */
  previewIndex: number | null;
  /**
   * True while a pointer is over the bar or carrying the knob, and for as
   * long afterwards as a knob it threw is still in the air.
   *
   * The bloom, the clear glass and the lens all hang off this. It is not the
   * same thing as `previewIndex`, which keyboard focus also sets and which
   * is still null while a pointer rests on the rail between options: the
   * knob has to lift the moment the pointer is over the bar, before it has
   * reached anything to preview.
   */
  pressed: boolean;
  /**
   * Where the knob is, in stop units — a fraction while dragging, a whole
   * stop otherwise.
   *
   * Whole stops are jumps that CSS eases between; a fraction is a knob that
   * follows the finger, and a lens that moves continuously has something new
   * to bend on every frame. It falls back to whole stops the moment the
   * finger lifts, so the knob settles onto a choice rather than staying
   * wherever it was let go.
   */
  position: number;
  /**
   * How hard the knob is being thrown, from 0 (still) to 1 (flung).
   *
   * Drives the squash: a knob in motion stretches along the direction it is
   * going and thins across it, then rounds back out when it stops. Where the
   * number comes from depends on which gesture is moving it — a drag reads
   * the pointer's speed, a throw scales it by the distance — because those
   * are the only measurements each one actually has. Either way the
   * deformation reads as weight, and weight you cannot vary is just an
   * animation playing.
   */
  squash: number;
  /**
   * True while the knob is travelling to a stop it was sent to.
   *
   * A hover or a tap names a stop and leaves; nothing is under the pointer
   * for the knob to follow, so it has to make the journey itself. It stays
   * lifted and deformed for the length of that journey and settles at the
   * end of it, which is what makes it read as being drawn to the option
   * rather than teleporting onto it. A drag never sets this: the knob is
   * already where it is being put, and the CSS hangs the 440ms glide off
   * this flag, which under a finger would only make the lens lag it.
   */
  settling: boolean;
  /** Send the knob to a stop — for hover and keyboard focus. */
  preview: (index: number | null) => void;
  /** Spread onto the track element. */
  handlers: {
    onPointerEnter: () => void;
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
  /** How many stops the bar has — the hit test clamps to them. */
  count: number;
  /** Where the knob rests when nothing is being previewed or dragged. */
  selectedIndex: number;
  /**
   * Choose the stop a drag was released over.
   *
   * Only the drag needs this. Every bar also commits in the option's own
   * `onClick`, and that is the whole commit path for a tap — but a drag that
   * ends over a different option produces no click on that option at all, so
   * without this the knob could be carried somewhere the caller never heard
   * about. See `onPointerUp` for why exactly one of the two fires.
   */
  onCommit: (index: number) => void;
}): SegmentedDrag {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  /* A pointer is over the bar. */
  const [hovering, setHovering] = useState(false);
  /*
    A pointer is down on the bar. Deliberately separate from `hovering`,
    which a resting pointer also sets, and from `previewIndex`, which
    keyboard focus sets as well: the three answer different questions and
    only their union decides whether the knob is lifted.
  */
  const [pressing, setPressing] = useState(false);
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
  /* The previous sample, for the speed the drag's squash is solved from. */
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

  /* Both timers outlive the gesture that started them by design, so both
     have to go when the control does — a journey that outlives its bar would
     set state on something that is no longer mounted. */
  useEffect(
    () => () => {
      cancelSettle();
      cancelTravel();
    },
    [],
  );

  /* The clamp is for the organisation bar, which reports -1 while no section
     is open. */
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
  const sampleSpeed = (next: number) => {
    /* performance.now, not Date.now: this is an elapsed-time measurement,
       and it should not be affected by the wall clock being adjusted. */
    const at = typeof performance === "undefined" ? 0 : performance.now();
    const previous = lastMove.current;
    lastMove.current = { position: next, at };
    if (!previous) return;
    const elapsed = at - previous.at;
    /* Two moves inside the same millisecond divide by zero, and the first
       move after a pause has a long elapsed time that would read as almost
       no speed at all — neither says anything about how fast the finger is
       going. */
    if (elapsed <= 0 || elapsed > 120) return;
    const speed = (Math.abs(next - previous.position) / elapsed) * 1000;
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
    /* Where the knob is right now, whether that is a stop it is resting on
       or a fraction a finger just let go of. Under half a stop away is
       really "it is already here" — there is no journey to animate, and
       starting one would deform it on the spot. */
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

  /*
    The gesture is over. `dragged` says whether it ever became one, which
    decides how much of the knob's state belongs to it: a gesture that
    carried the knob owns the position it left it at and the deformation its
    speed was driving, and both have to go. A press that never moved owns
    neither — the preview and the squash it is sitting in belong to the
    hover or the travel around it, and clearing them here would cut short the
    throw a tap has only just started.
  */
  const end = (dragged: boolean) => {
    dragging.current = false;
    moved.current = false;
    downPosition.current = null;
    dragIndex.current = null;
    lastMove.current = null;
    setPressing(false);
    setDragPosition(null);
    if (!dragged) return;
    setPreviewIndex(null);
    /* Letting go is a stop, however fast it was travelling a frame ago. */
    cancelSettle();
    setSquash(0);
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
    /*
      A settling knob is still lifted: it has not arrived yet, and dropping
      the bloom mid-flight would make it shrink away from the option it is
      being drawn to. It is also what keeps the whole effect on touch, where
      the pointer has already left by the time the click lands.
    */
    pressed: hovering || pressing || settling,
    position,
    squash,
    settling,
    preview: (index) => {
      /*
        A finger that is down owns the knob. Hover and focus both arrive
        here, and either one landing mid-drag would fight the gesture for the
        position: `travelTo` would put the 440ms glide back on a knob that is
        supposed to be pinned under the pointer, and `setPreviewIndex` would
        name a stop the finger has already left. Pointer capture suppresses
        most of this on its own — while it holds, boundary events go to the
        track rather than to the options — but focus does not go through
        capture, and capture is not taken until the gesture has actually
        become a drag.
      */
      if (dragging.current) return;
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
      onPointerDown: (event) => {
        dragging.current = true;
        moved.current = false;
        setPressing(true);
        downPosition.current = positionAtPointer(event);
        /*
          Deliberately not tracking, not capturing, and not calling off a
          travel already in flight. Moving the knob here is what made a tap
          teleport it under the finger, leaving nothing for the travel to
          animate; and the travel most likely in flight right now is the one
          hover started a moment ago toward the very option being pressed, so
          killing it here would stop the knob short of the thing the press is
          agreeing with. Both of those wait for the threshold below.
        */
      },
      onPointerMove: (event) => {
        if (!dragging.current) return;
        if (!moved.current) {
          const from = downPosition.current;
          if (from !== null && Math.abs(positionAtPointer(event) - from) < DRAG_THRESHOLD) return;
          moved.current = true;
          /*
            The gesture has become a drag, so the knob comes off its stop and
            under the finger — and that is the moment a hover travel has to be
            called off. While `settling` is set the CSS puts a 440ms glide
            back on `translate`, and a fractional position pushed a frame at a
            time through a 440ms glide is a knob several frames behind the
            pointer it is meant to be under.
          */
          cancelTravel();
          setSettling(false);
          /*
            Capture from here rather than from pointerdown, and the commit
            path depends on it. While the track holds the pointer, the
            compatibility mouse events are retargeted to it too, so the
            `click` that follows lands on the track — which has no handler —
            instead of on an option. That is what leaves exactly one commit
            per gesture: a tap never captures, so its click reaches the option
            and commits there, and a drag captures, so nothing but `onCommit`
            below can fire. Capturing on pointerdown instead would have taken
            the click away from taps as well.

            Measured on the running page, on the theme control. A tap: no
            capture, and the click lands on the option's own svg — one commit.
            A drag across two stops: gotpointercapture 21ms after pointerdown,
            and the click lands on the track — one commit, from here. A drag
            that starts and ends inside the same option, the case where both
            paths could plausibly have fired: still captured, still one commit
            on the track. That last one is why this matters rather than being
            tidiness — the organisation bar pushes a history entry per commit,
            and two identical entries cost a second press of the back button.

            The threshold is a fraction of one stop, a few pixels, so the
            pointer is still comfortably over the track when this runs.
          */
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        trackPointer(event);
      },
      onPointerUp: (event) => {
        if (!dragging.current) return;
        const dragged = moved.current;
        const index = dragged ? dragIndex.current : Math.round(positionAtPointer(event));
        if (dragged && event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        /* Read the target before `end` clears the gesture's state, and act on
           it after, so the knob is already back on whole stops before
           anything asks it to move. */
        end(dragged);
        if (index === null) return;
        if (dragged) {
          /*
            The knob is by definition already where it was put, so there is no
            journey left to animate — only the choice to hand over. Checked
            against every caller: the theme control, the organisation sections
            and the notification filter each also commit in the option's own
            `onClick`, and the capture above is what keeps the two from both
            firing. Committing the same value twice would be harmless in two
            of the three, but the organisation bar pushes a history entry per
            commit, and two identical entries mean the back button needs
            pressing twice — so the two paths are kept genuinely exclusive
            rather than merely idempotent.
          */
          onCommit(index);
          return;
        }
        /*
          A press that never moved is a tap, and a tap names a stop exactly
          the way hovering one does — so it goes the same way, preview then
          travel, rather than teleporting the knob under the finger. Usually
          this is a no-op: on both mouse and touch the option's own
          pointerenter has already named the same stop, and `travelTo` sees no
          distance left to cover. It earns its place on a press that lands on
          the rail between two options, where no option was ever entered.
        */
        setPreviewIndex(index);
        travelTo(index);
      },
      /*
        A touch that the browser takes back — turned into a page scroll, or
        interrupted by a call — is cancelled rather than lifted, and not every
        engine follows that with a pointerleave. Without both halves here the
        knob would stay lifted with nothing over it.
      */
      onPointerCancel: () => {
        end(moved.current);
        leave();
      },
      onPointerLeave: () => {
        /* A drag that wanders off the bar has not ended; it still owns the
           knob, and pointerup will say when it is over. */
        if (!dragging.current) leave();
      },
    },
  };
}
