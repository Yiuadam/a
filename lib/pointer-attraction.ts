export interface TouchCardTransform {
  driftX: number;
  driftY: number;
  scaleX: number;
  scaleY: number;
  originX: number;
  originY: number;
}

/** A finger response whose transformed rectangle stays inside its layout box. */
export function boundedTouchCardTransform(
  rawX: number,
  rawY: number,
  width: number,
  height: number,
): TouchCardTransform {
  const x = Math.max(-1, Math.min(1, rawX));
  const y = Math.max(-1, Math.min(1, rawY));
  const scaleX = 0.989 + Math.abs(x) * 0.007;
  const scaleY = 0.976 + Math.abs(y) * 0.015;

  return {
    scaleX,
    scaleY,
    driftX: x * width * (1 - scaleX) * 0.72,
    driftY: y * height * (1 - scaleY) * 0.72,
    /* Anchor the far side, leaving room for the surface to follow the finger. */
    originX: (1 - x) * 50,
    originY: (1 - y) * 50,
  };
}
