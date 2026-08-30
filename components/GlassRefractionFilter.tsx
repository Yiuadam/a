"use client";

import { useEffect, useState } from "react";
import {
  createGlassRefractionMap,
  GLASS_REFRACTION_MAP_SIZE,
} from "@/lib/glass-refraction";
import {
  GLASS_PERFORMANCE_QUERY,
  supportsDetailedGlass,
} from "@/lib/glass-performance";

const FILTER_ID = "bandup-live-glass-refraction";
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

function createMapUrl() {
  const canvas = document.createElement("canvas");
  canvas.width = GLASS_REFRACTION_MAP_SIZE;
  canvas.height = GLASS_REFRACTION_MAP_SIZE;
  const context = canvas.getContext("2d");
  if (!context) return null;

  const image = context.createImageData(GLASS_REFRACTION_MAP_SIZE, GLASS_REFRACTION_MAP_SIZE);
  image.data.set(createGlassRefractionMap());
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
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
        <filter
          id={FILTER_ID}
          x="-10%"
          y="-10%"
          width="120%"
          height="120%"
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
          <feDisplacementMap
            in="SourceGraphic"
            in2="glass-normal-map"
            scale="0.14"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
    </svg>
  );
}
