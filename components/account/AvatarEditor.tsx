"use client";

import { useEffect, useRef, useState } from "react";
import LoadingIndicator from "@/components/LoadingIndicator";
import {
  CENTRED,
  MAX_ZOOM,
  MIN_ZOOM,
  STAGE,
  clampView,
  placement,
  zoomAround,
  type View,
} from "./crop";
import { PictureProblem, loadImage, renderCrop, type LoadedImage } from "./condense";

/*
  Choosing which part of a photo becomes the profile picture.

  ---------------------------------------------------------------------------
  Why this exists at all

  Before it, the file the learner picked was uploaded whole and then displayed
  through `object-cover` on a circle. That silently crops to the middle of the
  frame, and the middle of a photograph is very rarely the face — a picture
  taken at arm's length ends up as a chin and a shoulder, and there is nothing
  the person can do about it except go and crop the file somewhere else first.
  Giving them the crop is the difference between an avatar they chose and one
  the app chose for them.

  ---------------------------------------------------------------------------
  How it is built

  The square in the middle *is* the crop: whatever is inside it is what gets
  saved, and the circle drawn over it is where the same picture will be cut off
  when it is displayed, so nothing is a surprise afterwards. The maths lives in
  ./crop.ts, entirely separate from this file, and is tested there.

  Everything is driven by pointer events, which is what makes one code path
  serve a mouse, a finger and a stylus. The alternative — mousedown plus
  touchstart — means two implementations, two sets of coordinates and two
  chances to get the drag wrong; and pointer capture, which is what keeps a
  drag alive when the finger leaves the square, has no touch-event equivalent
  worth writing. `touch-none` on the square is load-bearing next to it: without
  it the browser claims the gesture first and the page scrolls away under the
  finger instead of the picture moving.
*/

export default function AvatarEditor({
  file,
  onCancel,
  onUse,
}: {
  file: File;
  onCancel: () => void;
  /*
    Hands the finished square back and leaves the upload to the caller. The
    editor closes as soon as the picture is ready rather than staying open for
    the network, so the two failures a learner can meet stay separate and are
    described separately: "this picture can't be used", which is answered here,
    and "that didn't save", which is answered on the page.
  */
  onUse: (picture: Blob) => void;
}) {
  const [loaded, setLoaded] = useState<LoadedImage | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [view, setView] = useState<View>(CENTRED);

  const panelRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  /*
    Live pointers, by id. A ref rather than state because these change on every
    frame of a drag and nothing on screen is drawn from them — the view is. Put
    in state, a two-finger pinch would re-render this component twice per move
    for no visible difference.
  */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchGap = useRef<number | null>(null);

  useEffect(() => {
    /*
      `alive` guards the same race the account status fetch does. Choosing a
      second file while the first is still decoding re-runs this effect, and
      without the guard the slower decode lands last and the editor shows the
      picture the learner has already replaced.
    */
    let alive = true;
    let opened: LoadedImage | null = null;

    loadImage(file)
      .then((image) => {
        opened = image;
        if (!alive) {
          image.release();
          return;
        }
        setLoaded(image);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setProblem(
          error instanceof PictureProblem
            ? error.message
            : "That picture couldn't be opened. Please try another one.",
        );
      });

    return () => {
      alive = false;
      opened?.release();
    };
  }, [file]);

  useEffect(() => {
    /*
      Escape closes, a tap outside closes, the page behind cannot scroll, and
      Tab stays inside — the four things that separate a dialog from a div that
      happens to be on top of everything. The previous overflow value is put
      back rather than cleared, for the same reason MobileNav does it: this
      must not quietly undo an overflow style something else had set.
    */
    const returnFocusTo = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const stops = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex="0"]',
      );
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      onCancel();
    };

    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointerDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointerDown);
      document.body.style.overflow = previousOverflow;
      returnFocusTo?.focus?.();
    };
  }, [onCancel]);

  function beginPointer(e: React.PointerEvent<HTMLDivElement>) {
    if (!loaded) return;
    /*
      Capture is what keeps a drag alive once the finger or the cursor leaves
      the square, which on a phone is most drags. It is wrapped because it
      throws rather than returning false for a pointer the browser does not
      consider active — a synthetic event from a test, or a touch the system
      cancelled between the two lines — and an exception thrown out of an event
      handler tears the whole editor down over a gesture that could simply have
      been ignored.
    */
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Dragging still works; it just stops if the pointer leaves the square.
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    /*
      The gap is reset rather than measured here. A pinch that begins by
      measuring on the first move needs no notion of where it started, so
      putting a second finger down mid-drag cannot make the picture jump.
    */
    pinchGap.current = null;
  }

  function movePointer(e: React.PointerEvent<HTMLDivElement>) {
    const image = loaded;
    if (!image) return;
    const previous = pointers.current.get(e.pointerId);
    if (!previous) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const box = stageRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return;
    // Screen pixels into stage units. Measured per move, so the editor never
    // has to hold its own size in state — see the header of ./crop.ts.
    const toStage = STAGE / box.width;

    const points = [...pointers.current.values()];
    if (points.length >= 2) {
      const [a, b] = points;
      const gap = Math.hypot(a.x - b.x, a.y - b.y);
      const lastGap = pinchGap.current;
      pinchGap.current = gap;
      if (lastGap === null || lastGap <= 0 || gap <= 0) return;
      const midX = ((a.x + b.x) / 2 - (box.left + box.width / 2)) * toStage;
      const midY = ((a.y + b.y) / 2 - (box.top + box.height / 2)) * toStage;
      const ratio = gap / lastGap;
      setView((v) => zoomAround(v, image.width, image.height, v.zoom * ratio, midX, midY));
      return;
    }

    const dx = (e.clientX - previous.x) * toStage;
    const dy = (e.clientY - previous.y) * toStage;
    setView((v) => clampView({ ...v, x: v.x + dx, y: v.y + dy }, image.width, image.height));
  }

  function endPointer(e: React.PointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
    pinchGap.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Same reasoning as the capture above: releasing a pointer the browser
      // has already forgotten is not a failure worth propagating.
    }
  }

  /*
    Arrow keys move the picture the way a drag would, so the editor is usable
    without a pointing device at all. Shift makes the step large enough to
    cross the square in a few presses rather than a few dozen.
  */
  function nudge(e: React.KeyboardEvent<HTMLDivElement>) {
    const image = loaded;
    if (!image) return;
    const step = (e.shiftKey ? 120 : 40) as number;
    const by: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = by[e.key];
    if (!move) return;
    e.preventDefault();
    setView((v) => clampView({ ...v, x: v.x + move[0], y: v.y + move[1] }, image.width, image.height));
  }

  async function use() {
    const image = loaded;
    if (!image || working) return;
    setWorking(true);
    setProblem(null);
    try {
      onUse(await renderCrop(image, view));
    } catch (error: unknown) {
      setProblem(
        error instanceof PictureProblem
          ? error.message
          : "That picture couldn't be prepared. Please try another one.",
      );
      setWorking(false);
    }
  }

  const spot = loaded ? placement(view, loaded.width, loaded.height) : null;
  const percent = (value: number) => `${value * 100}%`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Purely visual. The tap-outside is handled on the document, so closing
          still works if a tap lands on something this does not cover. */}
      <div aria-hidden="true" className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="avatar-editor-title"
        tabIndex={-1}
        className="relative z-10 max-h-[calc(100dvh-2rem)] w-full max-w-sm overflow-y-auto rounded-2xl border border-slate-200 bg-surface p-5 shadow-xl focus:outline-none"
      >
        <h2 id="avatar-editor-title" className="text-[1.0625rem] font-semibold text-slate-900">
          Frame your picture
        </h2>
        <p className="mt-2 text-[0.9375rem] leading-7 text-slate-600">
          Drag the picture to move it, and use the slider to zoom. The circle is what other
          parts of BandUp will show.
        </p>

        <div
          ref={stageRef}
          role="group"
          aria-label="Your picture. Drag it to move it, or use the arrow keys."
          tabIndex={0}
          onPointerDown={beginPointer}
          onPointerMove={movePointer}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onKeyDown={nudge}
          className="relative mx-auto mt-5 aspect-square w-full max-w-[17rem] touch-none select-none overflow-hidden rounded-2xl bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
          style={{ cursor: loaded ? "grab" : "default" }}
        >
          {loaded && spot && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={loaded.url}
              alt=""
              draggable={false}
              className="pointer-events-none absolute max-w-none"
              style={{
                left: percent(spot.left),
                top: percent(spot.top),
                width: percent(spot.width),
                height: percent(spot.height),
              }}
            />
          )}

          {/*
            The circle. Drawn as a ring with an enormous spread shadow rather
            than as four dimmed rectangles: one element, no arithmetic, and it
            stays exactly circular at any size. The square clips the shadow, so
            "enormous" costs nothing.
          */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-full border-2 border-white/85"
            style={{ boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.45)" }}
          />

          {!loaded && !problem && (
            <p className="absolute inset-0 flex items-center justify-center text-sm text-slate-500">
              <LoadingIndicator label="Opening your picture…" />
            </p>
          )}
        </div>

        <div className="mt-5 flex items-center gap-3">
          <label htmlFor="avatar-zoom" className="text-sm font-medium text-slate-700">
            Zoom
          </label>
          <input
            id="avatar-zoom"
            type="range"
            min={MIN_ZOOM * 100}
            max={MAX_ZOOM * 100}
            step={1}
            disabled={!loaded}
            value={Math.round(view.zoom * 100)}
            onChange={(e) => {
              const image = loaded;
              if (!image) return;
              const next = Number(e.target.value) / 100;
              // Zoomed about the centre of the square, which is where a slider
              // implies it is happening. A pinch zooms about the fingers.
              setView((v) => zoomAround(v, image.width, image.height, next, 0, 0));
            }}
            className="h-6 w-full cursor-pointer accent-indigo-600 disabled:opacity-50"
          />
        </div>

        {loaded && (
          <p className="mt-3 text-sm text-slate-500">
            Your picture is {loaded.width} × {loaded.height}. BandUp saves a small square of it,
            so it uploads quickly even on a slow connection.
          </p>
        )}

        {problem && (
          <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[0.9375rem] leading-7 text-rose-800">
            {problem}
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={!loaded || working}
            onClick={use}
          >
            {working ? <LoadingIndicator label="Preparing…" announce={false} /> : "Use this picture"}
          </button>
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
