"use client";

import { useEffect } from "react";
import { boundedTouchCardTransform } from "@/lib/pointer-attraction";

/*
  One delegated pointer interaction for the whole app.

  Installing a listener on every card and button would make a page with forty
  question buttons run forty copies of the same logic. This keeps one active
  element and one animation-frame update, regardless of how busy the page is.

  The target itself never moves. Its text, icon, hit target and focus outline
  stay exactly where they were; the custom properties below are consumed only
  by a direct, decorative RefractiveGlassLayer. That lets the glass look as
  though it follows the pointer without making a label drift underneath it.
*/

/* Static `.card` panels are intentionally absent. A surface moves only when
   it is an actual control (or explicitly opts in), so information panels do
   not pretend to be clickable. */
const TARGET =
  "[data-pointer-attract], button, a[href], summary, [role='button'], .btn-primary, .btn-secondary";
const TOUCH_TARGET = TARGET;
const MAX_CARD_WIDTH = 560;
const MAX_CARD_HEIGHT = 190;
const FLOWING_CONTROL =
  ".theme-toggle-base, .interval-toggle-base, .panel-toggle-base, .speaking-engine-picker, .organization-view-tabs";
const GLASS_SURFACE = ".card, .liquid-glass, .premade-glass, [data-glass-surface]";
const REFRACTIVE_GLASS_LAYER = ":scope > .refractive-glass-layer";
const REFLECTION_FRAME_MS = 32;
const MAX_REFLECTION_DEVICE_PIXELS = 1_250_000;
const REDUCED_TRANSPARENCY_QUERY = "(prefers-reduced-transparency: reduce)";

/* A generic button may receive the low-cost directional reflection, but the
   magnetic/deforming response is reserved for controls that already contain
   an isolated visual glass layer. Moving a whole button would also move its
   label and accessible focus geometry, which is the opposite of a lens. */
function hasDirectRefractiveGlassLayer(target: HTMLElement) {
  return target.querySelector(REFRACTIVE_GLASS_LAYER) !== null;
}

function targetFrom(node: EventTarget | null, current: HTMLElement | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const target = node.closest<HTMLElement>(TARGET);
  if (!target || target.matches(":disabled") || target.closest(FLOWING_CONTROL)) return null;
  if (target === current) return target;
  if (!target.hasAttribute("data-pointer-attract")) {
    const rect = target.getBoundingClientRect();
    if (rect.width > MAX_CARD_WIDTH || rect.height > MAX_CARD_HEIGHT) return null;
  }
  return hasDirectRefractiveGlassLayer(target) ? target : null;
}

function touchTargetFrom(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const target = node.closest<HTMLElement>(TOUCH_TARGET);
  if (!target || target.matches(":disabled") || target.closest(FLOWING_CONTROL)) return null;
  if (!hasDirectRefractiveGlassLayer(target)) return null;
  if (target.hasAttribute("data-pointer-attract")) return target;
  const rect = target.getBoundingClientRect();
  return rect.width <= MAX_CARD_WIDTH && rect.height <= MAX_CARD_HEIGHT ? target : null;
}

function glassSurfaceFrom(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  return node.closest<HTMLElement>(GLASS_SURFACE);
}

function rest(target: HTMLElement | null) {
  if (!target) return;
  target.removeAttribute("data-pointer-attracting");
  target.removeAttribute("data-pointer-attract-touch");
  target.style.setProperty("--pointer-drift-x", "0px");
  target.style.setProperty("--pointer-drift-y", "0px");
  target.style.setProperty("--pointer-stretch-x", "1");
  target.style.setProperty("--pointer-stretch-y", "1");
}

function restGlass(target: HTMLElement | null) {
  if (!target) return;
  target.removeAttribute("data-glass-reflecting");
  target.style.removeProperty("--glass-reflection-x");
  target.style.removeProperty("--glass-reflection-y");
}

export default function PointerAttraction() {
  useEffect(() => {
    const canHover = window.matchMedia(
      "(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)",
    );
    const reducedTransparency = window.matchMedia(REDUCED_TRANSPARENCY_QUERY);
    let active: HTMLElement | null = null;
    let frame = 0;
    let clientX = 0;
    let clientY = 0;
    let touchPointerId: number | null = null;
    let touchBounds: DOMRect | null = null;
    let glassSurface: HTMLElement | null = null;
    let lastGlassSurface: HTMLElement | null = null;
    let lastReflectionPaint = -Infinity;
    let lastReflectionX = -1;
    let lastReflectionY = -1;
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;

    /* The ordinary CSS backdrop-filter is the real background sampler and is
       available to every card. Directional specular work is the adaptive
       part: it runs only on a fine pointer, never in a hidden tab, never with
       reduced motion or Save-Data, and only for the one surface under the
       pointer. A 32 ms paint floor caps this extra work near 30 fps. */
    const canReflect = () =>
      canHover.matches && !reducedTransparency.matches && !connection?.saveData &&
      document.visibilityState === "visible";

    const clear = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      rest(active);
      restGlass(glassSurface);
      active = null;
      glassSurface = null;
      lastGlassSurface = null;
      lastReflectionPaint = -Infinity;
      lastReflectionX = -1;
      lastReflectionY = -1;
      touchPointerId = null;
      touchBounds = null;
    };

    const draw = (timestamp: number) => {
      frame = 0;
      if (active && !active.isConnected) {
        rest(active);
        active = null;
      }

      if (active) {
        const rect = touchBounds ?? active.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          rest(active);
          active = null;
        } else {
          const x = Math.max(-1, Math.min(1, (clientX - (rect.left + rect.width / 2)) / (rect.width / 2)));
          const y = Math.max(-1, Math.min(1, (clientY - (rect.top + rect.height / 2)) / (rect.height / 2)));
          const touch = touchPointerId !== null;
          const icon = active.dataset.pointerAttractStrength === "icon";

          active.dataset.pointerAttractReady = "";
          active.dataset.pointerAttracting = "";
          if (touch) {
            /* A phone card deforms *inside* its layout box. Both scales stay below
               one, and the small drift is calculated from the space that shrinking
               created. This gives the finger a physical response without letting
               the painted card overlap its neighbours. */
            const response = boundedTouchCardTransform(x, y, rect.width, rect.height);
            active.dataset.pointerAttractTouch = "";
            active.style.setProperty("--pointer-drift-x", `${response.driftX.toFixed(2)}px`);
            active.style.setProperty("--pointer-drift-y", `${response.driftY.toFixed(2)}px`);
            active.style.setProperty("--pointer-stretch-x", response.scaleX.toFixed(4));
            active.style.setProperty("--pointer-stretch-y", response.scaleY.toFixed(4));
            active.style.setProperty("--pointer-origin-x", `${response.originX.toFixed(1)}%`);
            active.style.setProperty("--pointer-origin-y", `${response.originY.toFixed(1)}%`);
          } else {
            const drift = icon ? 3.2 : 2.2;
            const stretch = icon ? 0.012 : 0.006;
            active.style.setProperty("--pointer-drift-x", `${(x * drift).toFixed(2)}px`);
            active.style.setProperty("--pointer-drift-y", `${(y * drift).toFixed(2)}px`);
            active.style.setProperty("--pointer-stretch-x", String(1 + Math.abs(x) * stretch));
            active.style.setProperty("--pointer-stretch-y", String(1 + Math.abs(y) * stretch));
            active.style.setProperty("--pointer-origin-x", `${((x + 1) * 50).toFixed(1)}%`);
            active.style.setProperty("--pointer-origin-y", `${((y + 1) * 50).toFixed(1)}%`);
          }
        }
      }

      if (glassSurface && (!glassSurface.isConnected || !canReflect())) {
        restGlass(glassSurface);
        glassSurface = null;
      }

      if (glassSurface) {
        const surfaceChanged = lastGlassSurface !== glassSurface;
        if (surfaceChanged || timestamp - lastReflectionPaint >= REFLECTION_FRAME_MS) {
          const rect = glassSurface.getBoundingClientRect();
          const dpr = Math.min(window.devicePixelRatio || 1, 3);
          const visible =
            rect.width > 0 && rect.height > 0 &&
            rect.bottom > 0 && rect.right > 0 &&
            rect.top < window.innerHeight && rect.left < window.innerWidth &&
            rect.width * rect.height * dpr * dpr <= MAX_REFLECTION_DEVICE_PIXELS;
          /* Whole-percent quantisation avoids a style invalidation when a high
             polling-rate mouse moved but the visible highlight did not. */
          if (visible) {
            const x = Math.round(Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100)));
            const y = Math.round(Math.max(0, Math.min(100, ((clientY - rect.top) / rect.height) * 100)));
            if (surfaceChanged || x !== lastReflectionX || y !== lastReflectionY) {
              glassSurface.style.setProperty("--glass-reflection-x", `${x}%`);
              glassSurface.style.setProperty("--glass-reflection-y", `${y}%`);
              glassSurface.dataset.glassReflecting = "";
              lastReflectionX = x;
              lastReflectionY = y;
            }
          } else {
            restGlass(glassSurface);
          }
          lastGlassSurface = glassSurface;
          lastReflectionPaint = timestamp;
        }
      }
    };

    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        if (event.pointerId !== touchPointerId || !active) return;
        clientX = event.clientX;
        clientY = event.clientY;
        if (!frame) frame = requestAnimationFrame(draw);
        return;
      }
      if (!canHover.matches) return clear();
      const next = targetFrom(event.target, active);
      if (next !== active) {
        rest(active);
        active = next;
      }
      const nextGlass = canReflect() ? glassSurfaceFrom(event.target) : null;
      if (nextGlass !== glassSurface) {
        restGlass(glassSurface);
        glassSurface = nextGlass;
        lastGlassSurface = null;
      }
      clientX = event.clientX;
      clientY = event.clientY;
      if ((active || glassSurface) && !frame) frame = requestAnimationFrame(draw);
    };

    const down = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      const next = touchTargetFrom(event.target);
      if (!next) return;
      clear();
      active = next;
      touchPointerId = event.pointerId;
      touchBounds = next.getBoundingClientRect();
      clientX = event.clientX;
      clientY = event.clientY;
      frame = requestAnimationFrame(draw);
    };

    const release = (event: PointerEvent) => {
      if (event.pointerType === "touch" && event.pointerId === touchPointerId) clear();
    };

    const visibility = () => {
      if (document.visibilityState !== "visible") clear();
    };

    document.addEventListener("pointerdown", down, { passive: true });
    document.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerup", release, { passive: true });
    document.addEventListener("pointercancel", release, { passive: true });
    document.addEventListener("pointerleave", clear);
    window.addEventListener("blur", clear);
    window.addEventListener("pagehide", clear);
    window.addEventListener("scroll", clear, { passive: true });
    document.addEventListener("visibilitychange", visibility);
    canHover.addEventListener("change", clear);
    reducedTransparency.addEventListener("change", clear);

    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", release);
      document.removeEventListener("pointercancel", release);
      document.removeEventListener("pointerleave", clear);
      window.removeEventListener("blur", clear);
      window.removeEventListener("pagehide", clear);
      window.removeEventListener("scroll", clear);
      document.removeEventListener("visibilitychange", visibility);
      canHover.removeEventListener("change", clear);
      reducedTransparency.removeEventListener("change", clear);
      clear();
    };
  }, []);

  return null;
}
