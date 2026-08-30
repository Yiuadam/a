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
export type GlassRefractionMapOptions = {
  /**
   * Width divided by height of the pane this map will be stretched onto.
   * 1 keeps the historical square behaviour.
   *
   * The map is a square bitmap drawn onto a pane of any shape with
   * preserveAspectRatio="none", so every horizontal distance in it is
   * multiplied by the pane's aspect ratio on the way to the screen. Solving
   * the geometry in *height units* — x scaled up by the aspect ratio here so
   * the stretch scales it back down there — is what makes the bevel come out
   * the same number of pixels wide along the top as it is along the side, and
   * makes the encoded normals the true pixel-space normals rather than ones
   * skewed by the stretch. Without it a 360x56 card gets a bevel spanning
   * 115px horizontally against 18px vertically, which reads as a band across
   * the middle rather than as an edge.
   */
  aspect?: number;
  /** Corner radius, as a fraction of the pane's half-height. */
  cornerRadius?: number;
  /** Bevel width, as a fraction of the pane's half-height. */
  bezelWidth?: number;
  /**
   * How much the flat centre magnifies, across the pane's short axis.
   *
   * A bevel alone only bends what passes under the rim; the middle stays
   * inert, which is why a pane with one reads as a blurred hole rather than
   * as glass. A real lens does both — it spreads what is behind its centre
   * and compresses it hard at the edge. That pairing is what makes a line
   * crossing behind a pane come out thicker in the middle and hooked at the
   * rim, instead of merely nudged where it enters.
   *
   * Applied across the short axis only. On a pane as wide as a navigation
   * card, magnifying along the length would ask for a displacement of many
   * times the card's height and drag in content from well outside it; across
   * the height it is bounded by the height itself. That makes this a
   * cylindrical lens, which is the right model for a long, thin pane.
   */
  magnify?: number;
};

export function createGlassRefractionMap(
  size = GLASS_REFRACTION_MAP_SIZE,
  options: GlassRefractionMapOptions = {},
) {
  const { aspect = 1, cornerRadius = 0.3, bezelWidth = 0.16, magnify = 0 } = options;
  const pixels = new Uint8ClampedArray(size * size * 4);
  const halfExtent = 0.98;
  /* Half-extents in height units. The rounded rectangle is inset by its own
     corner radius on both axes, which is what the distance field is measured
     against. */
  const straightExtentX = aspect * halfExtent - cornerRadius;
  const straightExtentY = halfExtent - cornerRadius;

  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const x = (((column + 0.5) / size) * 2 - 1) * aspect;
      const y = ((row + 0.5) / size) * 2 - 1;
      const qx = Math.abs(x) - straightExtentX;
      const qy = Math.abs(y) - straightExtentY;
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
          normalX = (x - clamp(x, -straightExtentX, straightExtentX)) / cornerDistance;
          normalY = (y - clamp(y, -straightExtentY, straightExtentY)) / cornerDistance;
        } else if (qx > qy) {
          normalX = Math.sign(x) || 1;
        } else {
          normalY = Math.sign(y) || 1;
        }
      }

      /* Magnification pulls each sample toward the centre line by an amount
         proportional to how far from it that sample sits, which spreads the
         backdrop outward. It applies across the whole pane, not only the
         bevel, and is what keeps the middle from being inert; the bevel's
         outward bend then compresses it again at the rim. Inside the shape
         only — outside it there is no glass to magnify through. */
      const magnified = signedDistance <= 0 ? -magnify * y : 0;

      pixels[index] = Math.round(NEUTRAL_CHANNEL + clamp(normalX * bend, -1, 1) * 127);
      pixels[index + 1] = Math.round(
        NEUTRAL_CHANNEL + clamp(normalY * bend + magnified, -1, 1) * 127,
      );
      pixels[index + 2] = NEUTRAL_CHANNEL;
      pixels[index + 3] = 255;
    }
  }

  return pixels;
}
