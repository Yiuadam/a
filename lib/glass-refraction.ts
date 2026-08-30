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

/*
  How wide a strip, in the same height-normalised units as the rest of this
  file, the normal direction takes to rotate from vertical to horizontal
  along the diagonal from the centre toward each corner — see the comment
  where this is used below. Fixed rather than derived from any one card's own
  shape, since the discontinuity it is smoothing over exists for every card
  the same way regardless of aspect, corner radius, or how strong that card's
  own bend is tuned.
*/
const SEAM_TRANSITION_WIDTH = 0.12;

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
   * How thick the glass is: how far in from the rim the dome's curve begins,
   * as a fraction of the pane's half-height. Higher is thicker.
   *
   * The dome's own hemisphere slope is solved inside this band alone, mapped
   * so it always reaches its steepest exactly at the true rim — t = 1 right
   * at the edge, whatever the band's width — rather than reaching a cap
   * somewhere inside the band and running flat for the rest of the way out.
   * A flat run at the end is backwards: it puts the busiest, most tangled
   * bending part of the dome partway into the face and leaves the actual
   * outer edge looking like an even, unremarkable compression — a thin lens
   * turned inside out, not a thick one. The channel is clamped to its
   * displayable range at the very end, which is what keeps the slope's
   * approach to infinity at the true rim from doing anything worse than
   * saturating the last handful of pixels there — exactly where a real
   * dome's own bending goes into total internal reflection.
   *
   * A wide band spreads that climb over more of the face, which is what
   * makes a thicker pane's tangle occupy a broader ring instead of hugging a
   * hairline at the rim, without ever relocating the sharpest bend inward.
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
        } else {
          /* Away from the rounded corners, every point on a flat side is
             either closer to the vertical edges or closer to the horizontal
             ones — qx > qy or the reverse — and a hard switch between a
             purely horizontal and a purely vertical normal right at that
             boundary is an actual discontinuity in direction. A sharp jump
             in direction reads as a visible line even where the bend's own
             magnitude is small on both sides of it — far more visible than a
             smooth change of the same total size — and it runs from each
             corner in toward the centre, which is what showed up as
             straight seams cutting the pane into triangles.

             Blended instead, over a fixed width in the same
             height-normalised units signedDistance itself uses (not tied to
             any one card's thickness or corner radius, so the seam softens
             the same way regardless of shape): the normal rotates smoothly
             from vertical to horizontal across the line qx = qy rather than
             flipping there, and its own magnitude eases down through the
             transition rather than staying pinned to 1 on both sides of a
             cliff. */
          const seamBlend = clamp((qx - qy) / SEAM_TRANSITION_WIDTH, -1, 1);
          const horizontalWeight = (seamBlend + 1) / 2;
          normalX = horizontalWeight * (Math.sign(x) || 1);
          normalY = (1 - horizontalWeight) * (Math.sign(y) || 1);
        }
      }

      /* How far into the glass this sample sits, as a fraction of the way from
         the rim to the thick middle: 1 at the rim, 0 in the middle. This is
         the ramp's own domain — the whole face — so its "regular" pattern
         keeps spanning all the way from the centre to the edge. */
      const intoGlassFull = clamp(1 - -signedDistance / halfExtent, 0, 1);
      /* The dome's own domain is narrower: only the band of the given
         thickness closest to the rim, remapped so 1 always lands exactly on
         the true edge regardless of how wide that band is. Beyond it, toward
         the centre, the dome contributes nothing — the tangle stays confined
         to the rim's own band instead of bleeding into the flat middle. */
      const intoGlassBand = clamp(1 - -signedDistance / Math.max(thickness, 1e-3), 0, 1);
      const domeSlope = intoGlassBand / Math.sqrt(Math.max(1 - intoGlassBand * intoGlassBand, 1e-4));
      /* The dome pulls inward along the same surface normal the bevel pushes
         outward along, so the two share one direction field. Inward means it
         can never ask for a sample from beyond the pane's own edge. */
      const pull = dome * domeSlope + magnify * intoGlassFull;
      const alongNormal = bend - (signedDistance <= 0 ? pull : 0);

      pixels[index] = Math.round(NEUTRAL_CHANNEL + clamp(normalX * alongNormal, -1, 1) * 127);
      pixels[index + 1] = Math.round(NEUTRAL_CHANNEL + clamp(normalY * alongNormal, -1, 1) * 127);
      pixels[index + 2] = NEUTRAL_CHANNEL;
      pixels[index + 3] = 255;
    }
  }

  return pixels;
}
