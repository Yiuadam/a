"use client";

import dynamic from "next/dynamic";
import GlassPerformanceGate from "@/components/GlassPerformanceGate";

/*
  The upstream component reads `navigator` while rendering, so it cannot be
  prerendered safely. Keeping the browser-only boundary here lets the real
  homepage content remain ordinary server-rendered HTML; this component is a
  visual layer only and never owns links, text or focus.
*/
const LiquidGlass = dynamic(() => import("liquid-glass-react"), { ssr: false });

const STILL_POINTER = { x: 0, y: 0 };

/**
 * A visual-only displacement layer. It deliberately owns no pointer listener
 * or React state: PointerAttraction delegates one listener for the entire app
 * and paints the one surface currently under a fine pointer. That avoids one
 * render loop per glass control while keeping these opt-in SVG lenses as the
 * higher-detail layer over the shared CSS backdrop glass.
 */
export default function RefractiveGlassLayer({
  radius = 32,
  interactive = false,
}: {
  radius?: number;
  interactive?: boolean;
}) {
  return (
    <GlassPerformanceGate>
    <span
      className="refractive-glass-layer"
      data-interactive={interactive ? "" : undefined}
      aria-hidden="true"
    >
      <LiquidGlass
        className="refractive-glass-core"
        displacementScale={interactive ? 27 : 20}
        blurAmount={0.08}
        saturation={interactive ? 112 : 105}
        aberrationIntensity={interactive ? 0.35 : 0}
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
    </GlassPerformanceGate>
  );
}
