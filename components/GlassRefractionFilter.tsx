"use client";

import { useEffect, useState } from "react";
import {
  createGlassRefractionMap,
  GLASS_REFRACTION_MAP_SIZE,
  type GlassRefractionMapOptions,
} from "@/lib/glass-refraction";
import {
  GLASS_PERFORMANCE_QUERY,
  supportsDetailedGlass,
} from "@/lib/glass-performance";

const FILTER_ID = "bandup-live-glass-refraction";
/* A bevel confined to its own band at the rim, and nothing else — no dome,
   no magnify. Both of those bend along the surface normal measured from the
   *centre* outward, which is what a real lens does, but that same
   centre-reference is exactly the problem: a rounded rectangle's true
   distance-to-rim is shorter on the diagonal toward a corner than straight
   out from the middle, so any centre-referenced pull — however tightly
   `thickness` confines its strength to a thin band near the rim — still
   traces the panel's own rounded-rectangle contour some distance inward. On
   screen that read as a soft rounded shape sitting in the card's interior: a
   "circle" the user kept seeing, then a "triangle" once the direction
   discontinuity across it was smoothed away, and still a paler circle again
   even after that band was cut to a sliver (thickness 0.75, then 0.06) —
   because the shape was never the discontinuity or the band width, it was
   the mechanism. There is no dome/magnify tuning that avoids drawing some
   contour of itself across the flat part of the face.

   A bevel doesn't have that problem: its own profile is purely a function of
   distance from the rim, evaluated only inside its own band width
   (bezelWidth), so nothing about it reaches back toward the centre by
   construction — the flat part of the card is provably flat, not just tuned
   small. That reads as "flat thick" rather than "triangular thick": a
   uniform ring of bend at a chosen width around an inert middle, rather than
   a shape radiating in from every edge no matter how gently.

   The width is the thick slab, restored through this mechanism rather than
   the dome it was originally built on. What made that design read as a deep
   slab was never the dome itself: it was how far in from the rim the glass
   starts turning over — thickness 0.85, so the backdrop compresses across a
   wide band all the way round and the edge curves down to its underside,
   instead of a thin sheet whose roll-over hides in the last few percent.
   That value transfers directly, because `thickness` and `bezelWidth` are
   both fractions of the pane's half-height, and the bevel's own profile is
   already the same quarter-circle turning down hard at the rim.

   Measured on the nav card's own shape (aspect 1.4, corner 0.12), widening
   this from 0.35 takes the band from 26% of the half-width to 61% and the
   peak bend from 0.49 to 0.80, while the steepest bend stays out near the
   rim at 24% in and the middle stays flat. That is the slab's depth without
   the dome's centre-referenced contour — the one thing that could bring the
   circle back. */
const NAV_BEZEL_WIDTH = 0.85;
/* The displacement may reach this fraction of the card's half-height. A
   displacement map can only rearrange what is already inside the element's own
   box — sampling past it returns nothing — so a lens that asks to move a pixel
   further than the pane's own short radius pulls emptiness into the rim. Kept
   just under 1 so the strongest bend still lands on real backdrop.

   Raised from 0.85: the bevel band's own width (NAV_BEZEL_WIDTH) sets how
   much of the rim participates, but it was this headroom — not the band
   width — that kept the bend inside that band looking tame. Pushed close to
   the 1.0 ceiling so whatever sits behind the rim visibly bends, rather than
   just softly blurring, the way the reference glass's own edge does. */
const NAV_DISPLACEMENT_HEADROOM = 0.97;
/*
  Every card the SVG displacement filter applies to — not every card with the
  wall/rim CSS, which also reaches `.premade-glass` cards (see .card::before
  in globals.css). `.premade-glass` is left out here: it already runs its own
  live liquid-glass-react displacement, and warping those already-displaced
  pixels a second time is what produced visible smudging, so its cards get
  the static wall/rim dressing but never this filter. The two named `.card`
  exceptions are contexts that deliberately flatten to no glass at all, per
  the same comment in globals.css.

  `.nav-menu-group` is included alongside `.card`. It used to solve its own
  displacement map from its own measured shape, and was tried here once
  before and reverted: at the time, both that map and this bucketed one
  (generated for the nav card's own actual aspect 1.4, corner 0.12 shape and
  inspected directly, not just guessed at) showed colour spreading across
  nearly the whole face rather than staying confined to a thin rim band — see
  the comment on NAV_BEZEL_WIDTH above (shared as GENERIC_BEZEL_WIDTH) for
  what was actually wrong and how it was fixed. That read fine against a
  busy backdrop, where competing detail broke the pattern up, but as an
  obvious pale shape against a plain one — which is what the nav card's own
  backdrop now is. Retuned rather than reverted a second time, since the
  same bug would otherwise still be sitting underneath every other `.card`
  this filter reaches, just less visible against their busier backdrops.
*/
/*
  `.theme-toggle-selector` joins them so the theme control's knob can be the
  clear version of this material while it is being dragged: displacement
  only, no frost and no glow, so the icons and track behind it visibly
  reform rather than being hidden behind a frosted pill. It measures as a
  circle (aspect 1, corner clamped to 0.98), which the bucket grid already
  carries, so it costs no filter the page was not going to generate anyway.
  Only the CSS decides when to use it — see the [data-pressed] rules in
  globals.css, which are the only place it is switched on.
*/
const GENERIC_SELECTOR =
  ".card:not(.organization-team-pairings-page):not(.organization-team-pairing-group):not(.premade-glass), .nav-menu-group, .theme-toggle-selector";
/* Cards vary far more in shape than the handful of nav items ever did — a
   square icon tile and a full-width pricing card share nothing. Measuring
   each individually and building one filter per exact shape would mean a
   filter per card, most of them near-duplicates of each other. Instead every
   card is rounded to the nearest of a small, fixed grid of shapes and reuses
   whichever filter that grid point already has, generated once up front
   rather than grown on the fly. A card between two grid points reads a bevel
   a few percent off from its own exact proportions, which is not visible at
   the strengths these constants use. */
const GENERIC_ASPECT_BUCKETS = [0.4, 0.7, 1, 1.4, 2, 2.8, 4, 6, 9];
const GENERIC_CORNER_BUCKETS = [0.12, 0.3, 0.55, 0.8, 0.98];
const GENERIC_MAP_SIZE = 384;
const GENERIC_FILTER_PREFIX = "bandup-card-glass-lens";
/* Same lens physics as the navigation cards, at the same strength: this is
   meant to read as the identical material everywhere it appears, not a
   watered-down copy for everyday cards and the real thing only in the nav. */
const GENERIC_BEZEL_WIDTH = NAV_BEZEL_WIDTH;
/*
  The theme knob is the one surface that wants the opposite of the slab.

  A card is a wide, shallow pane, so a band reaching 61% of its half-width
  still reads as an edge rolling under. The knob is a circle, and on a
  circle that same 0.85 reaches 84% of the way in from the rim — the whole
  disc bends, which is what domed the icon underneath instead of leaving it
  sitting flat behind glass.

  Real glass with a flat face and a rounded edge does not do that: the
  middle shows what is behind it undisturbed and only the rim compresses.
  0.3 confines the bend to the outer 30% of the radius, so the centre is
  provably inert — the map's centre pixel is exactly 128,128 — and the
  background reforms only where the surface actually turns.

  Cards keep GENERIC_BEZEL_WIDTH. This is a second bezel width in the same
  system, not a change to the first, and it is keyed into the bucket key so
  the two never share a filter.
*/
const KNOB_SELECTOR = ".theme-toggle-selector";
const KNOB_BEZEL_WIDTH = 0.14;
/*
  How much harder blue bends than red, as a fraction of the green bend.

  This is the dispersion the reference glass actually shows at its rim, and
  until now it was a painted rainbow: a fixed gradient ring, the same hues
  in the same places whatever was behind the glass. That is a drawing of
  the effect rather than the effect. Real glass has a different refractive
  index per wavelength, so its edge pulls the backdrop's own colours apart
  by different amounts — which means the fringe is made of whatever is
  behind it, and a knob over plain grey shows none at all.

  One feDisplacementMap moves all three channels by one vector, so it can
  bend without ever separating. Three passes at three scales can: red a
  little less than green, blue a little more, then each pass contributing
  only its own channel. See the filter itself for the recombination.

  0.16 rather than something showier because the separation is a fraction
  of a bend that is already confined to the rim band — the flat middle has
  no displacement, so it gets no fringe, exactly as it should. Cards keep
  0 and their single pass: this is three times the displacement work, which
  is worth it for one 28px knob and not for every card on a page.
*/
const KNOB_DISPERSION = 0.16;
const GENERIC_DISPERSION = 0;
const GENERIC_DISPLACEMENT_HEADROOM = NAV_DISPLACEMENT_HEADROOM;
/* A page with an unusually long list of cards (an admin table, a long
   practice list) could in principle produce more distinct shape buckets than
   is worth generating filters for. This is a safety valve, not an expected
   ceiling — the fixed grid above already holds the real count to at most
   9 x 5 = 45, and most pages use only a handful of shapes. */
const GENERIC_MAX_BUCKETS = 45;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const REDUCED_TRANSPARENCY_QUERY = "(prefers-reduced-transparency: reduce)";

type PerformanceNavigator = Navigator & {
  connection?: {
    saveData?: boolean;
    addEventListener?: typeof addEventListener;
    removeEventListener?: typeof removeEventListener;
  };
  deviceMemory?: number;
};

function createMapUrl(options?: GlassRefractionMapOptions, size = GLASS_REFRACTION_MAP_SIZE) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return null;

  const image = context.createImageData(size, size);
  image.data.set(createGlassRefractionMap(size, options));
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}


function nearest(value: number, grid: number[]) {
  return grid.reduce((closest, candidate) =>
    Math.abs(candidate - value) < Math.abs(closest - value) ? candidate : closest,
  );
}

type GenericBucket = {
  aspect: number;
  cornerRadius: number;
  bezelWidth: number;
  dispersion: number;
  scale: number;
};

/* Bezel width is part of the identity, not just the shape: two panes can
   measure to the same rounded rectangle and still want different amounts of
   their face turning over — see KNOB_BEZEL_WIDTH. Keying it here is what
   stops the knob and a square card sharing one filter and one of them
   silently winning. */
function bucketKey(
  aspect: number,
  cornerRadius: number,
  bezelWidth: number,
  dispersion: number,
) {
  return [aspect, cornerRadius, bezelWidth, dispersion]
    .map((value) => value.toFixed(2))
    .join(":");
}

/*
  Every card matching GENERIC_SELECTOR, reduced to the small fixed grid of
  shapes described above it. This keeps one bucket per distinct shape rather
  than collapsing everything to a single median — a square icon tile and a
  wide pricing card are both real, simultaneous shapes on the same page, not
  variations on one card that should share a filter.
*/
function measureGenericPanes() {
  const panes = Array.from(document.querySelectorAll<HTMLElement>(GENERIC_SELECTOR));
  const buckets = new Map<string, GenericBucket>();
  const assignments = new Map<HTMLElement, string>();

  for (const pane of panes) {
    const { width, height } = pane.getBoundingClientRect();
    if (!(width > 0) || !(height > 0)) continue;

    const radius = Number.parseFloat(getComputedStyle(pane).borderTopLeftRadius) || 0;
    const halfHeight = height / 2;
    const aspect = nearest(width / height, GENERIC_ASPECT_BUCKETS);
    const cornerRadius = nearest(Math.min(radius / halfHeight, 0.98), GENERIC_CORNER_BUCKETS);
    const knob = pane.matches(KNOB_SELECTOR);
    const bezelWidth = knob ? KNOB_BEZEL_WIDTH : GENERIC_BEZEL_WIDTH;
    const dispersion = knob ? KNOB_DISPERSION : GENERIC_DISPERSION;
    const key = bucketKey(aspect, cornerRadius, bezelWidth, dispersion);
    assignments.set(pane, key);

    if (buckets.has(key) || buckets.size >= GENERIC_MAX_BUCKETS) continue;

    /* Scale depends only on the bucket's own aspect ratio, not its actual
       pixel size: width = aspect * height and halfHeight = height / 2, so
       scale = HEADROOM * halfHeight / diagonal reduces to
       HEADROOM / sqrt(2 * (aspect² + 1)) once height cancels out of both the
       numerator and the diagonal. That is what lets every card sharing a
       bucket also share its filter's fixed scale attribute regardless of how
       large that particular card actually is. */
    const scaleDivisor = Math.sqrt(2 * (aspect * aspect + 1));
    buckets.set(key, {
      aspect,
      cornerRadius,
      bezelWidth,
      dispersion,
      scale: GENERIC_DISPLACEMENT_HEADROOM / scaleDivisor,
    });
  }

  return { buckets, assignments };
}

function supportsLiveBackdropRefraction() {
  /* Safari parses `url(#filter)` in this property but drops the SVG stage at
     paint time. CSS.supports alone would therefore give a false positive and
     can make an iPhone panel disappear. The direct-live path is limited to
     Chromium, whose backdrop compositor actually runs the displacement map. */
  const browser = navigator as Navigator & {
    userAgentData?: { brands?: Array<{ brand: string }> };
  };
  const brands = browser.userAgentData?.brands?.map(({ brand }) => brand) ?? [];
  const chromiumBrand = brands.some((brand) =>
    /Chromium|Google Chrome|Microsoft Edge|Opera/i.test(brand),
  );
  const chromiumUserAgent = /(?:Chrome|Chromium|Edg|OPR)\//.test(navigator.userAgent)
    && !/CriOS|FxiOS/.test(navigator.userAgent);

  return (chromiumBrand || chromiumUserAgent) && CSS.supports(
    "backdrop-filter",
    `blur(1px) saturate(100%) url(#${FILTER_ID})`,
  );
}

/*
  An SVG displacement stage is GPU work, not a free opacity tweak. Keep it to
  desktops that have both a fine pointer and enough reported hardware headroom;
  all other devices keep the normal backdrop glass. This is deliberately the
  same eligibility contract as the optional refractive rim, so a page never
  enables one high-detail system while the other has declined it.
*/
function supportsDetailedLiveRefraction() {
  if (!supportsLiveBackdropRefraction()) return false;

  const browser = navigator as PerformanceNavigator;
  return supportsDetailedGlass({
    finePointer: window.matchMedia(GLASS_PERFORMANCE_QUERY).matches,
    reducedMotion: window.matchMedia(REDUCED_MOTION_QUERY).matches,
    reducedTransparency: window.matchMedia(REDUCED_TRANSPARENCY_QUERY).matches,
    saveData: Boolean(browser.connection?.saveData),
    memoryGb: Number.isFinite(browser.deviceMemory) ? browser.deviceMemory ?? null : null,
    cores: Number.isFinite(navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : null,
  });
}

/*
  A second, browser-agnostic eligibility path. `supportsDetailedLiveRefraction`
  above targets the combined `backdrop-filter: blur() url(#id)` syntax, which
  Safari silently drops the SVG stage from — that's a real, narrow WebKit gap,
  not a general "Safari can't do this" limitation. A `filter: url(#id)`
  applied as its OWN property to an element that separately carries its own
  `backdrop-filter: blur()` distorts that element's already-blurred output
  instead, and Safari runs that combination fine — it's exactly what the
  liquid-glass-react package this app already ships (RefractiveGlassLayer)
  relies on, with no Chromium check of its own.

  Consumers that use the split-property pattern read this flag instead of
  `supportsDetailedLiveRefraction`'s Chromium-only one. Deliberately no
  fine-pointer or reported-hardware requirement: the whole point is running
  this for every real user regardless of device, not guessing which ones
  have "enough" cores or memory — those guesses are exactly what excluded
  this app's own headless-Chromium test environment (a real, if unusually
  constrained, Chromium browser) during development. It still declines for
  someone who has explicitly asked their OS for reduced motion, reduced
  transparency, or a lighter page on a metered connection — those are
  stated preferences, not a guess about their hardware.
*/
function supportsSplitPropertyLens() {
  if (!CSS.supports("filter", `url(#${FILTER_ID})`)) return false;
  if (window.matchMedia(REDUCED_MOTION_QUERY).matches) return false;
  if (window.matchMedia(REDUCED_TRANSPARENCY_QUERY).matches) return false;

  const browser = navigator as PerformanceNavigator;
  return !browser.connection?.saveData;
}

/*
  The SVG is declared once for the whole document; individual panels only
  reference the stable filter id in CSS, so opening a menu or hovering a
  control never generates a new filter tree. Two eligibility paths share it:
  the combined `backdrop-filter: blur() url(#id)` syntax (Chromium only —
  see supportsDetailedLiveRefraction) and the split filter/backdrop-filter
  pattern (see supportsSplitPropertyLens) that also runs on Safari. Mounted
  whenever either path is eligible, so a consumer using only one of them
  still finds the filter definition in the document.
*/
export default function GlassRefractionFilter() {
  const [mapUrl, setMapUrl] = useState<string | null>(null);
  const [genericFilters, setGenericFilters] = useState<
    Array<{ key: string; id: string; url: string; scale: number; dispersion: number }>
  >([]);
  const [enabled, setEnabled] = useState(false);
  const [splitLensEnabled, setSplitLensEnabled] = useState(false);
  const filterNeeded = enabled || splitLensEnabled;

  useEffect(() => {
    const media = [
      window.matchMedia(GLASS_PERFORMANCE_QUERY),
      window.matchMedia(REDUCED_MOTION_QUERY),
      window.matchMedia(REDUCED_TRANSPARENCY_QUERY),
    ];
    const connection = (navigator as PerformanceNavigator).connection;
    const update = () => {
      setEnabled(supportsDetailedLiveRefraction());
      setSplitLensEnabled(supportsSplitPropertyLens());
    };

    update();
    for (const query of media) query.addEventListener("change", update);
    connection?.addEventListener?.("change", update);

    return () => {
      for (const query of media) query.removeEventListener("change", update);
      connection?.removeEventListener?.("change", update);
    };
  }, []);

  useEffect(() => {
    if (!filterNeeded || mapUrl) return;

    /* Same bevel width and displacement headroom as the bucketed system
       below (NAV_BEZEL_WIDTH / NAV_DISPLACEMENT_HEADROOM), so this Chromium
       combined-syntax path — the one plain .liquid-glass and .premade-glass
       panels use — reads as the same strength of glass rather than a softer
       one left on the library's own quieter defaults. */
    const source = createMapUrl({
      bezelWidth: NAV_BEZEL_WIDTH,
      maxDisplacement: NAV_DISPLACEMENT_HEADROOM,
    });
    if (!source) return;

    /* Defer the state update by one paint. This lets the rest of the page
       hydrate first and avoids a synchronous effect-driven render during
       first paint. */
    const frame = requestAnimationFrame(() => setMapUrl(source));
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [filterNeeded, mapUrl]);

  /*
    Every card, bucketed by shape rather than solved per-element (see
    measureGenericPanes). Assignments and filter definitions are rebuilt on
    the same schedule as the nav lens — resize and DOM mutation, since cards
    mount and unmount constantly across the site (route changes, tab
    switches, lists loading) in a way the nav menu's fixed set never does.
  */
  useEffect(() => {
    if (!splitLensEnabled) return;

    const known = new Map<
      string,
      { id: string; url: string; scale: number; dispersion: number }
    >();
    let frame = 0;

    const rebuild = () => {
      const { buckets, assignments } = measureGenericPanes();
      let changed = false;

      for (const [key, bucket] of buckets) {
        if (known.has(key)) continue;

        const source = createMapUrl(
          {
            aspect: bucket.aspect,
            cornerRadius: bucket.cornerRadius,
            bezelWidth: bucket.bezelWidth,
            maxDisplacement: GENERIC_DISPLACEMENT_HEADROOM,
          },
          GENERIC_MAP_SIZE,
        );
        if (!source) continue;

        known.set(key, {
          id: `${GENERIC_FILTER_PREFIX}-${known.size}`,
          url: source,
          scale: bucket.scale,
          dispersion: bucket.dispersion,
        });
        changed = true;
      }

      for (const [element, key] of assignments) {
        const entry = known.get(key);
        if (entry) element.style.setProperty("--glass-lens-filter", `url(#${entry.id})`);
      }

      if (changed) {
        setGenericFilters(
          Array.from(known, ([key, entry]) => ({ key, ...entry })),
        );
      }
    };

    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(rebuild);
    };

    schedule();
    window.addEventListener("resize", schedule);
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, [splitLensEnabled]);

  useEffect(() => {
    if (!mapUrl || !enabled) return;

    document.documentElement.dataset.liveGlassRefraction = "";
    return () => {
      delete document.documentElement.dataset.liveGlassRefraction;
    };
  }, [enabled, mapUrl]);

  useEffect(() => {
    if (!mapUrl || !splitLensEnabled) return;

    document.documentElement.dataset.glassLensSplit = "";
    return () => {
      delete document.documentElement.dataset.glassLensSplit;
    };
  }, [splitLensEnabled, mapUrl]);

  if (!mapUrl || !filterNeeded) return null;

  return (
    <svg
      className="glass-refraction-definitions"
      aria-hidden="true"
      focusable="false"
      width="0"
      height="0"
    >
      <defs>
        {/*
          The region is the pane itself, not a margin around it. A region
          larger than the element lets displaced pixels paint outside its
          own rounded rectangle, which showed up as a faint second copy of
          each card hanging past its bottom-right corner.
        */}
        <filter
          id={FILTER_ID}
          x="0%"
          y="0%"
          width="100%"
          height="100%"
          filterUnits="objectBoundingBox"
          primitiveUnits="objectBoundingBox"
          colorInterpolationFilters="sRGB"
        >
          <feImage
            href={mapUrl}
            x="0"
            y="0"
            width="1"
            height="1"
            preserveAspectRatio="none"
            result="glass-normal-map"
          />
          {/*
            With primitiveUnits="objectBoundingBox" this scale resolves
            against the pane's diagonal, not its shortest side. A navigation
            card is 360x56, so its diagonal is around 258px and a scale of
            0.24 asked for up to 62px of displacement on an element 56px
            tall — more than its whole height, which dragged content from
            outside the card into the middle of it as a hard-edged block.
            The bound that matters is the shortest pane sharing this filter,
            so the value stays small: the glass reads through its rim
            highlight and the bend at its edge, not through a displacement
            large enough to move the backdrop bodily.

            Raised from 0.06 in step with the map's own higher headroom
            above, so this Chromium-only combined path bends its backdrop as
            visibly as the bucketed lens does — still held well under the
            old 0.24 that caused the block-dragging bug, since this one
            scale is shared by every arbitrarily-shaped panel rather than
            solved per shape.
          */}
          <feDisplacementMap
            in="SourceGraphic"
            in2="glass-normal-map"
            scale="0.08"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>

        {/*
          One lens per shape bucket, shared by every card whose measured
          shape snapped to it (see measureGenericPanes). Structurally
          identical to the nav filter above — same physics, just solved for
          a grid of shapes instead of one measured pane.
        */}
        {genericFilters.map((entry) => (
          <filter
            key={entry.key}
            id={entry.id}
            x="0%"
            y="0%"
            width="100%"
            height="100%"
            filterUnits="objectBoundingBox"
            primitiveUnits="objectBoundingBox"
            colorInterpolationFilters="sRGB"
          >
            <feImage
              href={entry.url}
              x="0"
              y="0"
              width="1"
              height="1"
              preserveAspectRatio="none"
              result="generic-normal-map"
            />
            {entry.dispersion > 0 ? (
              <>
                {/*
                  Real dispersion, in place of a painted rainbow.

                  A prism separates because its refractive index depends on
                  wavelength: blue bends hardest, red least. One
                  feDisplacementMap cannot express that — it moves all three
                  channels by a single vector, so it bends without ever
                  separating, which is why the fringe had to be drawn on by
                  hand as a fixed gradient ring.

                  Three passes can. The same normal map, at three scales
                  either side of the true one, and then each pass allowed to
                  contribute only the channel it was solved for: red from the
                  gentlest bend, green from the middle, blue from the
                  strongest. Recombining them gives an edge whose colours
                  come apart the way the reference glass's do — made of
                  whatever is actually behind the pane, so a knob over flat
                  grey shows no fringe at all, and one over a hard edge
                  shows it exactly there.

                  The separation follows the bend, which is already confined
                  to the rim band, so the flat middle disperses nothing.
                */}
                <feDisplacementMap
                  in="SourceGraphic"
                  in2="generic-normal-map"
                  scale={entry.scale * (1 - entry.dispersion)}
                  xChannelSelector="R"
                  yChannelSelector="G"
                  result="lens-red"
                />
                <feDisplacementMap
                  in="SourceGraphic"
                  in2="generic-normal-map"
                  scale={entry.scale}
                  xChannelSelector="R"
                  yChannelSelector="G"
                  result="lens-green"
                />
                <feDisplacementMap
                  in="SourceGraphic"
                  in2="generic-normal-map"
                  scale={entry.scale * (1 + entry.dispersion)}
                  xChannelSelector="R"
                  yChannelSelector="G"
                  result="lens-blue"
                />
                {/*
                  Each matrix keeps one colour channel and passes alpha
                  through untouched. Alpha has to survive: these are
                  composited additively below, and a channel carried on zero
                  alpha is premultiplied away to nothing before it can be
                  added.
                */}
                <feColorMatrix
                  in="lens-red"
                  type="matrix"
                  values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
                  result="only-red"
                />
                <feColorMatrix
                  in="lens-green"
                  type="matrix"
                  values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
                  result="only-green"
                />
                <feColorMatrix
                  in="lens-blue"
                  type="matrix"
                  values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
                  result="only-blue"
                />
                <feComposite
                  in="only-red"
                  in2="only-green"
                  operator="arithmetic"
                  k2="1"
                  k3="1"
                  result="red-green"
                />
                <feComposite
                  in="red-green"
                  in2="only-blue"
                  operator="arithmetic"
                  k2="1"
                  k3="1"
                />
              </>
            ) : (
              <feDisplacementMap
                in="SourceGraphic"
                in2="generic-normal-map"
                scale={entry.scale}
                xChannelSelector="R"
                yChannelSelector="G"
              />
            )}
          </filter>
        ))}
      </defs>
    </svg>
  );
}
