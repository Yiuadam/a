/*
  A Liquid Glass pane is flat through most of its surface. The bend happens
  where the material curves into its edge. This map encodes that behaviour:
  neutral mid-grey in the centre and an outward-facing X/Y vector only in a
  narrow rounded-rectangle bezel.

  The values are deliberately generated from geometry rather than from noise.
  A noise map makes a page look watery; a signed-distance-field map gives the
  browser the normal direction of the glass edge, which is the cue our eyes
  recognise as a lens.
*/
export const GLASS_REFRACTION_MAP_SIZE = 128;

const NEUTRAL_CHANNEL = 128;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Builds an RGBA displacement map for a rounded square. SVG scales this map
 * to each pane, while the map itself keeps the centre optically flat and the
 * border physically lens-like. R controls horizontal displacement and G
 * controls vertical displacement; 128 is neutral for both channels.
 */
export function createGlassRefractionMap(size = GLASS_REFRACTION_MAP_SIZE) {
  const pixels = new Uint8ClampedArray(size * size * 4);
  const halfExtent = 0.94;
  const cornerRadius = 0.32;
  /* A clear, substantial bevel is what makes a pane read as a lens rather
     than a soft blur. It still leaves the broad centre completely neutral.
     Wider and rounder than before — every glass card here is rounded on
     all four sides, not just at the corners, so the bend needs to read
     like a real convex edge running around a curved 3D panel rather than
     a thin ring concentrated only where the corners are tightest. */
  const bezelWidth = 0.32;
  const straightExtent = halfExtent - cornerRadius;

  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const x = ((column + 0.5) / size) * 2 - 1;
      const y = ((row + 0.5) / size) * 2 - 1;
      const qx = Math.abs(x) - straightExtent;
      const qy = Math.abs(y) - straightExtent;
      const outsideX = Math.max(qx, 0);
      const outsideY = Math.max(qy, 0);
      const cornerDistance = Math.hypot(outsideX, outsideY);
      const signedDistance = cornerDistance + Math.min(Math.max(qx, qy), 0) - cornerRadius;
      const index = (row * size + column) * 4;

      let normalX = 0;
      let normalY = 0;
      let bend = 0;

      if (signedDistance <= 0) {
        /* The inner portion is flat; the bevel follows an actual spherical
           cross-section rather than a linear ramp. Take the bevel in
           profile as a quarter circle that meets the flat centre tangentially
           and turns down hard at the rim: surface height y = sqrt(1 - p²)
           for p running 0 (inner edge) to 1 (rim), whose slope is
           p / sqrt(1 - p²).

           That slope is what the eye reads as glass thickness. It stays
           near zero across the inner bevel and then climbs steeply through
           the outer third, so a line of text passing under the pane runs
           straight until it reaches the rim and then visibly bends — the
           way it does under a real convex panel, instead of drifting
           gently across the whole border the way an even falloff makes it. */
        const p = clamp(1 - -signedDistance / bezelWidth, 0, 1);
        bend = clamp(p / Math.sqrt(Math.max(1 - p * p, 0.02)), 0, 1);

        if (cornerDistance > 0.0001) {
          normalX = (x - clamp(x, -straightExtent, straightExtent)) / cornerDistance;
          normalY = (y - clamp(y, -straightExtent, straightExtent)) / cornerDistance;
        } else if (qx > qy) {
          normalX = Math.sign(x) || 1;
        } else {
          normalY = Math.sign(y) || 1;
        }
      }

      pixels[index] = Math.round(NEUTRAL_CHANNEL + normalX * bend * 127);
      pixels[index + 1] = Math.round(NEUTRAL_CHANNEL + normalY * bend * 127);
      pixels[index + 2] = NEUTRAL_CHANNEL;
      pixels[index + 3] = 255;
    }
  }

  return pixels;
}
