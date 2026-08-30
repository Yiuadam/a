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
/* No separate bevel band on the navigation cards.

   A bevel only acts within its own width of the rim, so it puts a band of
   behaviour around the perimeter that the middle of the card does not share:
   the outer part stops obeying the same refraction as the inside, and the
   join between them is visible. What is left is one smooth field — a
   cylindrical magnifier whose displacement grows steadily from nothing at
   the centre line to its strongest at the edge — so a line crossing behind
   the card is bent by the same rule wherever it crosses, and the pane reads
   as one piece of glass rather than as a middle with a rim stuck round it.

   It is also inherently safe: magnification pulls each sample toward the
   centre, so it can never ask for one from beyond the card's own edge, which
   is what the outward bevel did and what drew the outer ring. */
const NAV_BEZEL_WIDTH = 0;
/* Was 0.55 — tuned up over several earlier rounds for "a bit more edge
   reflection", against a display bug that meant nobody actually saw the
   result (see the comment on `.nav-menu-group::before` in globals.css).
   Rendering the map for real and sampling it directly (pixel deviation from
   neutral along a line from the centre out to the rim) showed magnify
   contributing real colour well before the rim — at 0.55, roughly a third of
   full strength by the halfway point, entirely on its own account, since its
   ramp runs across the whole face by design (see its doc comment in
   lib/glass-refraction.ts) rather than being confined by `thickness` the way
   `dome` is. That reads as an unwanted tint through the body of the card,
   not an edge effect, so it is cut low enough to stay under the threshold
   human colour vision actually notices against a neutral background —
   enough that the body is not perfectly inert, not enough to compete with
   dome for the rim. */
const NAV_MAGNIFY = 0.03;
/* The rim of a real glass dome, on top of that body. A hemisphere's
   refraction follows its surface slope, which stays gentle across the face
   and then climbs almost vertically in the last stretch — that late climb is
   what folds the backdrop into a tight tangled band at the edge, on the
   rounded ends as much as the long sides. A straight ramp cannot produce it
   at any strength, because it has no steep part. */
const NAV_DOME = 0.25;
/* How far in from the rim the glass starts rolling over — its thickness,
   the actual source of the wide "blob" this whole block of comments is
   about, more than magnify above ever was. Was 0.75, on the belief that a
   wider band reads as a deep slab; measured directly instead (render the
   map for the card's own real shape, sample deviation from neutral along a
   line out from the centre), a card is not just tall or wide but has
   *corners*, and the true distance-to-rim near a corner is far shorter than
   halfExtent would suggest — so a 0.75-wide band, meant to describe "most of
   a deep slab", actually covered nearly the entire face once every direction
   toward every edge and corner was accounted for, not just the one this file
   used to check (straight out toward the middle of the long side). The dome
   read as an even, room-filling wash rather than glass, however correct the
   underlying hemisphere maths were. A band an order of magnitude narrower
   confines that same steep climb to roughly the outer tenth of the face —
   an actual thin bevel — while leaving dome's own peak slope at the true rim
   completely untouched, since domeSlope's climb to its asymptote near the
   rim doesn't depend on how wide the band leading up to it is. */
const NAV_THICKNESS = 0.06;
/* The displacement may reach this fraction of the card's half-height. A
   displacement map can only rearrange what is already inside the element's own
   box — sampling past it returns nothing — so a lens that asks to move a pixel
   further than the pane's own short radius pulls emptiness into the rim. Kept
   just under 1 so the strongest bend still lands on real backdrop. */
const NAV_DISPLACEMENT_HEADROOM = 0.85;
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
  NAV_MAGNIFY and especially NAV_THICKNESS below (shared as GENERIC_MAGNIFY
  and GENERIC_THICKNESS) for what was actually wrong and how it was measured.
  That read fine against a busy backdrop, where competing detail broke the
  pattern up, but as an obvious pale blob against a plain one — which is what
  the nav card's own backdrop now is. Retuned rather than reverted a second
  time, since the same bug would otherwise still be sitting underneath every
  other `.card` this filter reaches, just less visible against their busier
  backdrops.
*/
const GENERIC_SELECTOR =
  ".card:not(.organization-team-pairings-page):not(.organization-team-pairing-group):not(.premade-glass), .nav-menu-group";
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
const GENERIC_MAGNIFY = NAV_MAGNIFY;
const GENERIC_DOME = NAV_DOME;
const GENERIC_THICKNESS = NAV_THICKNESS;
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

type GenericBucket = { aspect: number; cornerRadius: number; scale: number };

function bucketKey(aspect: number, cornerRadius: number) {
  return `${aspect.toFixed(2)}:${cornerRadius.toFixed(2)}`;
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
    const key = bucketKey(aspect, cornerRadius);
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
    Array<{ key: string; id: string; url: string; scale: number }>
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

    const source = createMapUrl();
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

    const known = new Map<string, { id: string; url: string; scale: number }>();
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
            bezelWidth: GENERIC_BEZEL_WIDTH,
            magnify: GENERIC_MAGNIFY,
            dome: GENERIC_DOME,
            thickness: GENERIC_THICKNESS,
            maxDisplacement: GENERIC_DISPLACEMENT_HEADROOM,
          },
          GENERIC_MAP_SIZE,
        );
        if (!source) continue;

        known.set(key, {
          id: `${GENERIC_FILTER_PREFIX}-${known.size}`,
          url: source,
          scale: bucket.scale,
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
          */}
          <feDisplacementMap
            in="SourceGraphic"
            in2="glass-normal-map"
            scale="0.06"
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
            <feDisplacementMap
              in="SourceGraphic"
              in2="generic-normal-map"
              scale={entry.scale}
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        ))}
      </defs>
    </svg>
  );
}
