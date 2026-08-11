"use client";

import { useEffect } from "react";
import { boundedTouchCardTransform } from "@/lib/pointer-attraction";

/*
  One delegated pointer interaction for the whole app.

  Installing a listener on every card and button would make a page with forty
  question buttons run forty copies of the same logic. This keeps one active
  element and one animation-frame update, regardless of how busy the page is.

  `translate` and `scale` are individual transform properties. They compose
  with components that already use `transform` for an active press or an icon
  layer, instead of overwriting those effects.
*/

const TARGET = "[data-pointer-attract], button, .card, .btn-primary, .btn-secondary";
const TOUCH_TARGET = ".card";
const FLOWING_CONTROL =
  ".theme-toggle-base, .interval-toggle-base, .panel-toggle-base, .speaking-engine-picker";

function targetFrom(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const target = node.closest<HTMLElement>(TARGET);
  if (!target || target.matches(":disabled") || target.closest(FLOWING_CONTROL)) return null;
  return target;
}

function touchTargetFrom(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  return node.closest<HTMLElement>(TOUCH_TARGET);
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

export default function PointerAttraction() {
  useEffect(() => {
    const canHover = window.matchMedia(
      "(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)",
    );
    let active: HTMLElement | null = null;
    let frame = 0;
    let clientX = 0;
    let clientY = 0;
    let touchPointerId: number | null = null;
    let touchBounds: DOMRect | null = null;

    const clear = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      rest(active);
      active = null;
      touchPointerId = null;
      touchBounds = null;
    };

    const draw = () => {
      frame = 0;
      if (!active || !active.isConnected) return clear();
      const rect = touchBounds ?? active.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return clear();

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
      const next = targetFrom(event.target);
      if (next !== active) {
        rest(active);
        active = next;
      }
      if (!active) return;
      clientX = event.clientX;
      clientY = event.clientY;
      if (!frame) frame = requestAnimationFrame(draw);
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

    document.addEventListener("pointerdown", down, { passive: true });
    document.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerup", release, { passive: true });
    document.addEventListener("pointercancel", release, { passive: true });
    document.addEventListener("pointerleave", clear);
    window.addEventListener("blur", clear);
    window.addEventListener("scroll", clear, { passive: true });
    canHover.addEventListener("change", clear);

    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", release);
      document.removeEventListener("pointercancel", release);
      document.removeEventListener("pointerleave", clear);
      window.removeEventListener("blur", clear);
      window.removeEventListener("scroll", clear);
      canHover.removeEventListener("change", clear);
      clear();
    };
  }, []);

  return null;
}
