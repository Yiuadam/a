"use client";

import dynamic from "next/dynamic";
import GlassPerformanceGate from "@/components/GlassPerformanceGate";
import { resolveOptics, type GlassOptics } from "@/lib/glass-lab";

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
  optics = "standard",
}: {
  radius?: number;
  interactive?: boolean;
  optics?: GlassOptics;
}) {
  /*
    Resolving here, rather than trusting the prop directly, is what keeps the
    lab CSS out of a build that never opted in: a caller may request the
    enhanced treatment freely, but resolveOptics only lets it through to the
    DOM as a data-optics attribute when NEXT_PUBLIC_GLASS_LAB was "1" at build
    time. The rules that key off that attribute are themselves pure CSS — no
    JavaScript ships for them and no extra pointer listener is installed; the
    existing delegated PointerAttraction engine already supplies the
    reflection coordinates they read.
  */
  const resolved = resolveOptics(optics);
  return (
    <GlassPerformanceGate>
    <span
      className="refractive-glass-layer"
      data-interactive={interactive ? "" : undefined}
      data-optics={resolved === "enhanced" ? "enhanced" : undefined}
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
