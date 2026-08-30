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
   * Strength of a dome over the whole pane, displacing along its surface
   * normal.
   *
   * This is the pane modelled as a real piece of glass with a curved face
   * rather than a flat sheet with a bevel stuck round it. Two things follow
   * from taking that literally.
   *
   * The direction is the surface normal at each point, not one fixed axis, so
   * the top and bottom edges bend the backdrop downward and upward, the
   * rounded ends bend it inward along their own curve, and the corners bend it
   * diagonally. A purely vertical magnification leaves the ends flat, which is
   * exactly what a dome does not do.
   *
   * The amount follows a hemisphere's surface slope, t / sqrt(1 - t²) for t
   * running from the middle of the glass out to its rim. That stays gentle
   * across most of the face and then climbs almost vertically in the last
   * stretch, which is what folds the backdrop into a tight tangled band right
   * at the edge — the look of the rim of a real glass dome. A straight ramp
   * cannot produce it at any strength: it has no steep part.
   *
   * Displacement points inward, toward the thick middle of the glass, so it
   * can never ask for a sample from beyond the pane's own edge.
   */
  dome?: number;
  /**
   * A straight ramp along the same inward normal, added under the dome.
   *
   * The dome alone is gentle across most of the face by construction — all
   * its strength is saved for the rim — so on its own it leaves the body of
   * the pane doing very little. This carries the body: displacement growing
   * evenly from nothing in the middle to its full value at the rim, which is
   * what gives the whole face a steady bend for the dome's tangle to sit on
   * top of.
   */
  magnify?: number;
  /**
   * How thick the glass is, as how far in from the rim its edge starts
   * rolling over. Higher is thicker.
   *
   * A hemisphere's slope is unbounded at the rim, so it has to be capped; the
   * cap is what decides how much of the face the edge occupies. A high cap
   * keeps the steep part in the last few percent — a thin lens with a sharp
   * rim. A low one starts the roll-over much further in, so a wide band of
   * the face is turning over toward the bottom, the backdrop compresses across
   * all of it, and the pane reads as a deep slab whose edge curves down rather
   * than a sheet with a bevelled border.
   */
  thickness?: number;
  /**
   * How far a full-strength channel actually moves a pixel, as a fraction of
   * the pane's half-height.
   *
   * The map does not otherwise know what the displacement scale will be, and
   * it has to, because the outward bend must never ask for a sample from
   * beyond the pane's own edge — there is nothing there to read, and the
   * emptiness that comes back is what makes a card look ringed. Matches the
   * scale the filter is given.
   */
  maxDisplacement?: number;
};

export function createGlassRefractionMap(
  size = GLASS_REFRACTION_MAP_SIZE,
  options: GlassRefractionMapOptions = {},
) {
  const {
    aspect = 1,
    cornerRadius = 0.3,
    bezelWidth = 0.16,
    dome = 0,
    magnify = 0,
    thickness = 0.33,
    /* Uncapped by default, so the sitewide square map keeps exactly the shape
       it had. Only a caller that knows its own displacement scale can say
       what the bend must stay within. */
    maxDisplacement = Number.POSITIVE_INFINITY,
  } = options;
  /* Where the dome's slope is treated as fully turned over: past this the
     profile is flat out. Expressed as thickness so a larger number means a
     deeper slab, which is the inverse of the raw slope cap. */
  const slopeCap = 1 / Math.max(thickness, 1e-3);
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
        const p = clamp(1 - -signedDistance / Math.max(bezelWidth, 1e-6), 0, 1);
        const profile = clamp(p / Math.sqrt(Math.max(1 - p * p, 0.02)), 0, 1);

        /* A pane can only refract what is behind it. The bevel bends outward,
           so a sample taken further out than the rim is actually beyond the
           element, where the filter has nothing to read — it comes back empty,
           and the material recedes from its own edge in a transparent band.
           On screen that band separates the glass from its rim highlight and
           reads as a hard outer ring around the card.

           So the bend is held to the distance still available to it: at the
           rim, none, rising as the glass thickens inward. The strongest bend
           therefore sits just inside the edge rather than on it, which is
           where a real bevel's steepest slope is anyway, and every sample
           lands on backdrop that exists. */
        const available =
          Number.isFinite(maxDisplacement) && maxDisplacement > 0
            ? -signedDistance / maxDisplacement
            : Number.POSITIVE_INFINITY;
        bend = Math.min(profile, available);

        if (cornerDistance > 0.0001) {
          normalX = (x - clamp(x, -straightExtentX, straightExtentX)) / cornerDistance;
          normalY = (y - clamp(y, -straightExtentY, straightExtentY)) / cornerDistance;
        } else if (qx > qy) {
          normalX = Math.sign(x) || 1;
        } else {
          normalY = Math.sign(y) || 1;
        }
      }

      /* How far into the glass this sample sits, as a fraction of the way from
         the rim to the thick middle: 1 at the rim, 0 in the middle. */
      const intoGlass = clamp(1 - -signedDistance / halfExtent, 0, 1);
      const domeSlope =
        Math.min(
          intoGlass / Math.sqrt(Math.max(1 - intoGlass * intoGlass, 1e-4)),
          slopeCap,
        ) / slopeCap;
      /* The dome pulls inward along the same surface normal the bevel pushes
         outward along, so the two share one direction field. Inward means it
         can never ask for a sample from beyond the pane's own edge. */
      const pull = dome * domeSlope + magnify * intoGlass;
      const alongNormal = bend - (signedDistance <= 0 ? pull : 0);

      pixels[index] = Math.round(NEUTRAL_CHANNEL + clamp(normalX * alongNormal, -1, 1) * 127);
      pixels[index + 1] = Math.round(NEUTRAL_CHANNEL + clamp(normalY * alongNormal, -1, 1) * 127);
      pixels[index + 2] = NEUTRAL_CHANNEL;
      pixels[index + 3] = 255;
    }
  }

  return pixels;
}
