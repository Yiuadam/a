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

function smoothstep(from: number, to: number, value: number) {
  const progress = clamp((value - from) / (to - from), 0, 1);
  return progress * progress * (3 - 2 * progress);
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
  const cornerRadius = 0.24;
  const bezelWidth = 0.16;
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
        /* The inner portion is flat. Smoothly concentrate the bend in the
           curved bevel, with the strongest displacement right at the rim. */
        bend = 1 - smoothstep(0, bezelWidth, -signedDistance);

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
