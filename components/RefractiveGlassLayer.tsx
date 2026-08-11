"use client";

import dynamic from "next/dynamic";

/*
  The upstream component reads `navigator` while rendering, so it cannot be
  prerendered safely. Keeping the browser-only boundary here lets the real
  homepage content remain ordinary server-rendered HTML; this component is a
  visual layer only and never owns links, text or focus.
*/
const LiquidGlass = dynamic(() => import("liquid-glass-react"), { ssr: false });

const STILL_POINTER = { x: 0, y: 0 };

export default function RefractiveGlassLayer({ radius = 32 }: { radius?: number }) {
  return (
    <span className="refractive-glass-layer" aria-hidden="true">
      <LiquidGlass
        className="refractive-glass-core"
        displacementScale={20}
        blurAmount={0.08}
        saturation={105}
        aberrationIntensity={0}
        elasticity={0}
        cornerRadius={radius}
        padding="0"
        globalMousePos={STILL_POINTER}
        mouseOffset={STILL_POINTER}
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          width: "100%",
          height: "100%",
        }}
      >
        <span />
      </LiquidGlass>
    </span>
  );
}
