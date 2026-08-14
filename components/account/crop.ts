/*
  The arithmetic behind the profile-picture editor, deliberately kept away from
  the DOM.

  Everything in here is a pure function of numbers, which is the point. The
  editor itself is all pointers, refs and transforms — the part of a component
  that cannot be tested without a browser — and cropping is the part where a
  mistake is silent rather than loud. A crop rectangle that runs a fraction of
  a pixel past the edge of the source does not throw: it draws a transparent
  strip down one side of the picture, which then becomes a black strip once the
  canvas is flattened onto white and encoded as JPEG. Pulling the maths out
  here means tests/avatar-crop.test.mjs can assert the property that actually
  matters — the crop always lies inside the image — without launching anything.

  ---------------------------------------------------------------------------
  The coordinate systems, because there are three and they are easy to confuse.

    source units   pixels of the image the learner chose, which may be 6000
                   across or 90.
    stage units    a fixed, imaginary square of STAGE units on a side. Every
                   view is expressed against this square, never against the
                   real on-screen size of the editor.
    screen pixels  what a finger or a mouse actually moves through.

  The middle one exists so that resizing the window, rotating a phone, or
  rendering the same editor at 260px on a phone and 340px on a laptop, does not
  change the crop by a single pixel. The component converts a drag from screen
  pixels into stage units once, by measuring its own box during the gesture,
  and from then on nothing here knows or cares how big the editor is on screen.
  The first draft measured that element into React state instead, and the crop
  then shifted whenever the on-screen size changed between the drag and the
  save — which on a phone is every time the address bar collapses.
*/

/** The imaginary square every view is expressed against. See the header. */
export const STAGE = 1000;

/*
  Zoom is a multiplier on top of "cover": at 1 the image is exactly as large as
  it needs to be to fill the square, whichever way round it is. That is why the
  minimum is 1 rather than something smaller — below it the picture would no
  longer fill the crop and the result would have empty edges, which for an
  avatar is never what anyone wanted.

  The ceiling is 4 because past that a phone photo is being enlarged rather
  than cropped, and the result starts to look like a mistake the app made
  rather than a choice the learner made.
*/
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

/*
  The square that gets uploaded. Avatars are displayed at no more than 64 CSS
  pixels, so 256 still gives a 3x phone screen 64 spare source pixels; anything
  larger is bytes the learner waits for and nobody ever sees.

  The floor matters for the opposite case. Somebody uploading a 100-pixel
  picture from an old forum account should not have it inflated to 256 — that
  invents detail which was never there and makes the file bigger for the
  privilege — so the output is capped by the crop's own size, down to a floor
  that stops a thumbnail becoming a postage stamp.
*/
export const OUTPUT_SIZE = 256;
export const MIN_OUTPUT_SIZE = 96;

/** How the learner has positioned and enlarged the picture inside the square. */
export interface View {
  /** Multiplier on the cover scale. 1 exactly fills the square. */
  zoom: number;
  /** Where the image's centre sits relative to the square's centre, in stage units. */
  x: number;
  y: number;
}

/** A square in source pixels, ready to hand to drawImage. */
export interface Crop {
  x: number;
  y: number;
  size: number;
}

export const CENTRED: View = { zoom: 1, x: 0, y: 0 };

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  const held = Math.min(high, Math.max(low, value));
  /*
    Negative zero is folded back to zero. It comes out of the clamp whenever a
    drag is pulled hard against a bound that is itself -0, which is most of
    them: the slack in each direction is a subtraction, and a square picture at
    rest has no slack at all. It renders identically and behaves identically in
    arithmetic, so it is invisible until something compares views with Object.is
    — React's own state bail-out does exactly that — or a test asserts a
    position is 0 and is told it is -0 instead.
  */
  return held === 0 ? 0 : held;
}

/**
 * Stage units per source pixel at zoom 1 — the scale at which the image just
 * covers the square. It keys off the *shorter* side, which is what makes a
 * panorama and a portrait shot both fill the crop instead of one of them
 * leaving gaps.
 */
export function coverScale(imageW: number, imageH: number): number {
  const shorter = Math.min(imageW, imageH);
  return shorter > 0 ? STAGE / shorter : 1;
}

/**
 * Pulls a view back inside the bounds the crop can actually use.
 *
 * Two rules, and the second is the one that prevents the black strip described
 * in the header: the zoom stays between its limits, and the picture may never
 * be dragged far enough for the square to see past its edge. The slack in each
 * direction is however much of the image sticks out beyond the square, halved,
 * because the offset is measured centre to centre.
 */
export function clampView(view: View, imageW: number, imageH: number): View {
  const zoom = clamp(view.zoom, MIN_ZOOM, MAX_ZOOM);
  const scale = coverScale(imageW, imageH) * zoom;
  const slackX = Math.max(0, (imageW * scale - STAGE) / 2);
  const slackY = Math.max(0, (imageH * scale - STAGE) / 2);
  return { zoom, x: clamp(view.x, -slackX, slackX), y: clamp(view.y, -slackY, slackY) };
}

/**
 * Changes the zoom while holding one point still.
 *
 * This is what makes a pinch feel like a pinch. Without it the picture zooms
 * about its own centre, so the face someone has carefully positioned slides
 * out from under their fingers and they have to chase it back. `pointX` and
 * `pointY` are in stage units measured from the centre of the square, which is
 * the same frame the offsets live in.
 *
 * The zoom is clamped *before* the ratio is worked out. Doing it afterwards
 * looked identical until a pinch ran past the ceiling, at which point the
 * position kept drifting while the zoom stood still.
 */
export function zoomAround(
  view: View,
  imageW: number,
  imageH: number,
  nextZoom: number,
  pointX: number,
  pointY: number,
): View {
  const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
  const ratio = view.zoom > 0 ? zoom / view.zoom : 1;
  return clampView(
    {
      zoom,
      x: pointX - (pointX - view.x) * ratio,
      y: pointY - (pointY - view.y) * ratio,
    },
    imageW,
    imageH,
  );
}

/**
 * The square of the source image the editor is currently showing.
 *
 * The final clamp is not belt and braces. `size` and the centre are both
 * reached by division, so at the extremes of a drag the answer lands a
 * ten-thousandth of a pixel outside the image — enough for drawImage to sample
 * nothing along one edge, and enough for a test asserting containment to fail
 * in a way that reads like a rounding curiosity rather than the real bug it is.
 */
export function cropRect(view: View, imageW: number, imageH: number): Crop {
  const safe = clampView(view, imageW, imageH);
  const scale = coverScale(imageW, imageH) * safe.zoom;
  const size = Math.min(STAGE / scale, imageW, imageH);
  const centreX = imageW / 2 - safe.x / scale;
  const centreY = imageH / 2 - safe.y / scale;
  return {
    x: clamp(centreX - size / 2, 0, Math.max(0, imageW - size)),
    y: clamp(centreY - size / 2, 0, Math.max(0, imageH - size)),
    size,
  };
}

/** How large the uploaded square should be, given how much of the source it covers. */
export function outputSize(cropSize: number): number {
  return Math.max(MIN_OUTPUT_SIZE, Math.min(OUTPUT_SIZE, Math.round(cropSize)));
}

/**
 * Where to place the image inside the square, as fractions of the square's own
 * edge, for the component to hand straight to CSS as percentages.
 *
 * Returned in fractions rather than pixels so the editor never has to know its
 * own size in order to lay itself out — see the note about coordinate systems
 * at the top. Positioning the image by percentage is also the reason rotating
 * a phone mid-edit leaves the picture exactly where it was.
 */
export function placement(view: View, imageW: number, imageH: number) {
  const safe = clampView(view, imageW, imageH);
  const scale = coverScale(imageW, imageH) * safe.zoom;
  const width = (imageW * scale) / STAGE;
  const height = (imageH * scale) / STAGE;
  return {
    width,
    height,
    left: 0.5 - width / 2 + safe.x / STAGE,
    top: 0.5 - height / 2 + safe.y / STAGE,
  };
}
