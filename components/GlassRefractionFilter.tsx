"use client";

import { useEffect, useState } from "react";
import {
  createGlassRefractionMap,
  GLASS_REFRACTION_MAP_SIZE,
} from "@/lib/glass-refraction";

const FILTER_ID = "bandup-live-glass-refraction";

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
  Chromium can run an SVG filter on the live backdrop itself. The SVG is
  declared once for the whole document; individual panels only reference the
  stable filter id in CSS, so opening a menu or hovering a control never
  generates a new filter tree.

  Safari currently drops SVG URLs from backdrop-filter. It deliberately keeps
  the normal frosted-glass fallback there while the scene-copy lens is built;
  claiming the CSS-only route works on iPhone would be a visual lie.
*/
export default function GlassRefractionFilter() {
  const [mapUrl, setMapUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!supportsLiveBackdropRefraction()) return;

    const source = createMapUrl();
    if (!source) return;

    /* Defer the state update by one paint. This lets the rest of the page
       hydrate first and avoids a synchronous effect-driven render during
       first paint. */
    const frame = requestAnimationFrame(() => setMapUrl(source));
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (!mapUrl) return;

    document.documentElement.dataset.liveGlassRefraction = "";
    return () => {
      delete document.documentElement.dataset.liveGlassRefraction;
    };
  }, [mapUrl]);

  if (!mapUrl) return null;

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
            scale="0.04"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
    </svg>
  );
}
