"use client";

import { useEffect, useState } from "react";
import {
  createGlassRefractionMap,
  GLASS_REFRACTION_MAP_SIZE,
  type GlassRefractionMapOptions,
} from "@/lib/glass-refraction";
import {
  GLASS_PERFORMANCE_QUERY,
  supportsDetailedGlass,
} from "@/lib/glass-performance";

const FILTER_ID = "bandup-live-glass-refraction";
/* A bevel confined to its own band at the rim, and nothing else — no dome,
   no magnify. Both of those bend along the surface normal measured from the
   *centre* outward, which is what a real lens does, but that same
   centre-reference is exactly the problem: a rounded rectangle's true
   distance-to-rim is shorter on the diagonal toward a corner than straight
   out from the middle, so any centre-referenced pull — however tightly
   `thickness` confines its strength to a thin band near the rim — still
   traces the panel's own rounded-rectangle contour some distance inward. On
   screen that read as a soft rounded shape sitting in the card's interior: a
   "circle" the user kept seeing, then a "triangle" once the direction
   discontinuity across it was smoothed away, and still a paler circle again
   even after that band was cut to a sliver (thickness 0.75, then 0.06) —
   because the shape was never the discontinuity or the band width, it was
   the mechanism. There is no dome/magnify tuning that avoids drawing some
   contour of itself across the flat part of the face.

   A bevel doesn't have that problem: its own profile is purely a function of
   distance from the rim, evaluated only inside its own band width
   (bezelWidth), so nothing about it reaches back toward the centre by
   construction — the flat part of the card is provably flat, not just tuned
   small. That reads as "flat thick" rather than "triangular thick": a
   uniform ring of bend at a chosen width around an inert middle, rather than
   a shape radiating in from every edge no matter how gently.

   The width is the thick slab, restored through this mechanism rather than
   the dome it was originally built on. What made that design read as a deep
   slab was never the dome itself: it was how far in from the rim the glass
   starts turning over — thickness 0.85, so the backdrop compresses across a
   wide band all the way round and the edge curves down to its underside,
   instead of a thin sheet whose roll-over hides in the last few percent.
   That value transfers directly, because `thickness` and `bezelWidth` are
   both fractions of the pane's half-height, and the bevel's own profile is
   already the same quarter-circle turning down hard at the rim.

   Measured on the nav card's own shape (aspect 1.4, corner 0.12), widening
   this from 0.35 takes the band from 26% of the half-width to 61% and the
   peak bend from 0.49 to 0.80, while the steepest bend stays out near the
   rim at 24% in and the middle stays flat. That is the slab's depth without
   the dome's centre-referenced contour — the one thing that could bring the
   circle back. */
const NAV_BEZEL_WIDTH = 0.85;
/* The displacement may reach this fraction of the card's half-height. A
   displacement map can only rearrange what is already inside the element's own
   box — sampling past it returns nothing — so a lens that asks to move a pixel
   further than the pane's own short radius pulls emptiness into the rim. Kept
   just under 1 so the strongest bend still lands on real backdrop.

   Raised from 0.85: the bevel band's own width (NAV_BEZEL_WIDTH) sets how
   much of the rim participates, but it was this headroom — not the band
   width — that kept the bend inside that band looking tame. Pushed close to
   the 1.0 ceiling so whatever sits behind the rim visibly bends, rather than
   just softly blurring, the way the reference glass's own edge does. */
const NAV_DISPLACEMENT_HEADROOM = 0.97;
/*
  Every card the SVG displacement filter applies to — not every card with the
  wall/rim CSS, which also reaches `.premade-glass` cards (see .card::before
  in globals.css). `.premade-glass` is left out here deliberately: those
  surfaces are meant to be clear frosted glass and nothing more, so they get
  the static wall/rim dressing but never a lens. The two named `.card`
  exceptions are contexts that deliberately flatten to no glass at all, per
  the same comment in globals.css.

  `.nav-menu-group` is included alongside `.card`. It used to solve its own
  displacement map from its own measured shape, and was tried here once
  before and reverted: at the time, both that map and this bucketed one
  (generated for the nav card's own actual aspect 1.4, corner 0.12 shape and
  inspected directly, not just guessed at) showed colour spreading across
  nearly the whole face rather than staying confined to a thin rim band — see
  the comment on NAV_BEZEL_WIDTH above (shared as GENERIC_BEZEL_WIDTH) for
  what was actually wrong and how it was fixed. That read fine against a
  busy backdrop, where competing detail broke the pattern up, but as an
  obvious pale shape against a plain one — which is what the nav card's own
  backdrop now is. Retuned rather than reverted a second time, since the
  same bug would otherwise still be sitting underneath every other `.card`
  this filter reaches, just less visible against their busier backdrops.
*/
/*
  `.theme-toggle-selector` joins them so the theme control's knob can be the
  clear version of this material while it is being dragged: displacement
  only, no frost and no glow, so the icons and track behind it visibly
  reform rather than being hidden behind a frosted pill. It measures as a
  circle (aspect 1, corner clamped to 0.98), which the bucket grid already
  carries, so it costs no filter the page was not going to generate anyway.
  Only the CSS decides when to use it — see the [data-pressed] rules in
  globals.css, which are the only place it is switched on.
*/
/*
  Cards and the nav menu used to be in this list and are not any more.

  The lens was rejected on look, side by side against the same page with it
  switched off: what it actually drew on a card was a bright rounded-
  rectangle contour standing inside the card's own outline, with the corner
  arc visibly broken where the two disagreed. That disagreement is inherent
  to bucketing rather than a tuning error. A pane's shape is snapped to the
  nearest of a fixed grid before its map is solved, and the grid is coarse
  where real cards actually live: the account card measures a corner ratio
  of 0.209 and is given a map drawn for 0.12, which is 43% off, and the nav
  menu's 0.258 is served by 0.3. A bevel solved for one arc, stretched over
  another, has to show the seam somewhere, and on a large flat card there is
  nothing to hide it.

  Finer buckets would narrow that gap and not close it, at the cost of more
  filters and a bigger map per shape. The knobs keep the lens and want it:
  they are small, they measure as circles, and a circle is the one shape the
  grid holds exactly (aspect 1, corner clamped to 0.98), so there is no
  mismatch to see. Every card on the page also stops generating a 384px map
  and a filter tree it no longer references.

  The two CSS rules that applied it — `.card::before` and
  `.nav-menu-group::before` — went with this; cards keep their ordinary
  frosted backdrop glass, which is what the comparison preferred.
*/
const GENERIC_SELECTOR =
  ".card:not(.organization-team-pairings-page):not(.organization-team-pairing-group), .nav-menu-group, .theme-toggle-selector, .segmented-knob";
/* Cards vary far more in shape than the handful of nav items ever did — a
   square icon tile and a full-width pricing card share nothing. Measuring
   each individually and building one filter per exact shape would mean a
   filter per card, most of them near-duplicates of each other. Instead every
   card is rounded to the nearest of a small, fixed grid of shapes and reuses
   whichever filter that grid point already has, generated once up front
   rather than grown on the fly. A card between two grid points reads a bevel
   a few percent off from its own exact proportions, which is not visible at
   the strengths these constants use. */
/*
  Aspect is quantised coarsely and the corner finely, and the asymmetry is
  deliberate.

  The corner is what the seam was about — a card measuring 0.209 served by a
  map drawn for 0.12 — so it stays fine enough that the residual is a
  rounding hair. Aspect had no such problem, and it has a problem of its own:
  a knob squashes as it travels, so its width and height change every frame,
  and at a fine step every frame of that animation is a new shape, a new
  filter and a new map. A quarter is coarse enough that a whole squash
  collapses to one key.
*/
const GENERIC_ASPECT_STEP = 0.25;
const GENERIC_CORNER_STEP = 0.03;
/* Smaller than the 384 this was, and it can be: a map that describes the
   pane's own exact shape does not need extra resolution to survive being
   stretched onto a shape it does not match. What size buys now is only the
   smoothness of the arc itself. Halving the area matters because there is
   one of these per distinct shape on a page rather than per grid point. */
const GENERIC_MAP_SIZE = 256;
/*
  The knob's own maps are built far smaller than the cards'.

  A displacement map is a smooth gradient stretched onto whatever it is
  applied to, so its useful resolution is set by the element it lands on. A
  card is hundreds of pixels across and wants 384. A knob is about 52, and
  at 384 the phone decodes and samples a bitmap more than seven times finer
  than anything it can show — every frame it moves, because the content
  under a moving lens changes and the filter has to run again.
*/
const KNOB_MAP_SIZE = 96;
const GENERIC_FILTER_PREFIX = "bandup-card-glass-lens";
/* Same lens physics as the navigation cards, at the same strength: this is
   meant to read as the identical material everywhere it appears, not a
   watered-down copy for everyday cards and the real thing only in the nav. */
/* Cards take the knob's band width rather than the nav slab's 0.85.

   That 0.85 reaches 61% of a card's half-width, which is most of the face
   turning over — it was chosen to read as a deep slab back when the map was
   snapped to a coarse grid and the bend had to be broad to survive the
   mismatch. Now that each pane's map is solved from its own measured shape,
   the bend can sit where the glass actually turns, which is what was asked
   for: refraction that begins at the card's edge instead of drawing a shape
   across its middle.

   Narrower than the knobs' own 0.5, though, and that is not inconsistency.
   The width is a fraction of the pane's half-height, so the same number is a
   very different band in absolute terms: 0.5 on a 42px knob is 10px and
   reads as a rim, while 0.5 on a 400px poster is 100px and reads as most of
   the card. Rendered at 0.5 the spectral fringe spread across the face in
   washes rather than tracing the edge. 0.18 puts a card's band back in the
   same tens-of-pixels range the knob's is, which is what makes it read as
   the same material rather than the same number. */
const GENERIC_BEZEL_WIDTH = 0.18;
/*
  The theme knob is the one surface that wants the opposite of the slab.

  A card is a wide, shallow pane, so a band reaching 61% of its half-width
  still reads as an edge rolling under. The knob is a circle, and on a
  circle that same 0.85 reaches 84% of the way in from the rim — the whole
  disc bends, which is what domed the icon underneath instead of leaving it
  sitting flat behind glass.

  Real glass with a flat face and a rounded edge does not do that: the
  middle shows what is behind it undisturbed and only the rim compresses.
  A narrower band confines the bend to the outer part of the radius, so the
  centre stays inert — the map's centre pixel is exactly 128,128 — and the
  background reforms only where the surface actually turns.

  How narrow, though, is a trade the eye settles rather than the maths. At
  0.14 the bend peaked at 1.8px on a 42px knob, which is a hairline: the
  band was there, it was measurable, and it was not visible. The bend is
  held to the distance still available before a sample would fall off the
  pane, so widening the band is the only way to buy more of it. 0.5 peaks
  around 5px and spreads the turn across a broad ring, which is what a thick
  circle actually looks like, while still leaving the inner half of the disc
  at exactly neutral — so the icon sitting at the centre comes through flat.

  0.6 was rendered against the same straight rule and looks near-identical,
  for about 10% more peak bend. It is not worth taking, because it lands the
  band's inner termination where KNOB_INNER_EASE below can no longer soften
  it: measured as the largest jump in slope along a line running inward,
  easing takes 0.5 from 13.2 to 6.2, and takes 0.6 from 6.7 the wrong way,
  to 8.3. 0.5 eased is the smoothest surface of the three. Since the crease
  is the artefact that took several passes to get rid of in the first place,
  a tenth more bend is a bad trade for putting it back.

  Cards keep GENERIC_BEZEL_WIDTH. This is a second bezel width in the same
  system, not a change to the first, and it is keyed into the bucket key so
  the two never share a filter.
*/
/* Every option bar's knob, not just the theme control's — the organisation
   sections and the notification filter carry `.segmented-knob` alongside
   their own class so they read as the same material. */
const KNOB_SELECTOR = ".theme-toggle-selector, .segmented-knob";
const KNOB_BEZEL_WIDTH = 0.5;
/*
  How much harder blue bends than red, as a fraction of the green bend.

  This is the dispersion the reference glass actually shows at its rim, and
  until now it was a painted rainbow: a fixed gradient ring, the same hues
  in the same places whatever was behind the glass. That is a drawing of
  the effect rather than the effect. Real glass has a different refractive
  index per wavelength, so its edge pulls the backdrop's own colours apart
  by different amounts — which means the fringe is made of whatever is
  behind it, and a knob over plain grey shows none at all.

  One feDisplacementMap moves all three channels by one vector, so it can
  bend without ever separating. Three passes at three scales can: red a
  little less than green, blue a little more, then each pass contributing
  only its own channel. See the filter itself for the recombination.

  0 — off, after being cut from 0.16 to 0.05 to 0.02 and still showing.

  This is a real mechanism and it was worth building: three passes at three
  scales genuinely separate the backdrop's own colours, and over a hard
  edge it produced a fringe that appeared only where there was contrast to
  split. But it was safe only while the displacement lived in the rim band.
  Once the whole face bends (KNOB_MAGNIFY), the same split reaches
  everything the knob covers — including this app's 1.3px icon strokes,
  which came through with yellow and magenta on them. A monochrome glyph
  with coloured edges reads as a fault however physically it was derived,
  and the reference's own icon shows no colour at all.

  Kept in the code rather than deleted: the machinery is correct and a
  larger pane with a rim-only bevel could still use it. It is this knob,
  at this size, with a whole-face lens over hairline artwork, that cannot.

  Historical note on the values it passed through:
  Dispersion scales with the displacement it is splitting, and while that
  displacement lived only in the rim band a large coefficient was safe:
  the flat middle had no bend, so it got no fringe. Once the whole face
  bends, the same coefficient separates everywhere, and a monochrome icon
  in the middle came out with red and green edges on every stroke — an
  aberration fault rather than glass. Small enough now that the fringe is
  perceptible only where the displacement is largest, which is still the
  rim. Cards keep
  0 and their single pass: this is three times the displacement work, which
  is worth it for one 28px knob and not for every card on a page.
*/
const KNOB_DISPERSION = 0;
const GENERIC_DISPERSION = 0;
/*
  Adaptive tint: glass that darkens over bright content and lightens over
  dark, rather than carrying one fixed fill whatever it happens to cover.

  This is the trait that most separates the reference material from a
  translucent panel. A fixed fill has to be a compromise — light enough not
  to smother a dark backdrop, dark enough to keep white text legible over a
  bright one — and it fails at both ends. Glass that answers its own
  backdrop does neither: it takes luminance out of whatever is behind it, so
  contrast under the pane is compressed toward the middle and the content on
  top stays readable over anything.

  Derived, not guessed. The filter already holds the sampled backdrop, so
  luminanceToAlpha turns it into a per-pixel luminance mask; black flooded
  through that mask veils the bright parts, white flooded through its
  inverse lifts the dark ones. Both are local, so one pane crossing a hard
  edge is veiled on one side and lifted on the other — which is exactly what
  a fixed fill cannot express.

  Only the nav cards, which are the surface that actually sits over
  arbitrary page content. `.card` mostly sits on the page's own wash, where
  there is little for this to answer, and it is ~90 usages — not somewhere
  to make a sitewide change on a mechanism this new.
*/
/*
  A specular highlight solved from the pane's own shape, rather than a
  gradient drawn across it at a fixed angle.

  A painted highlight cannot know what it is lighting. One linear gradient
  reads plausibly on a circle and wrongly on a wide card, because a real
  highlight is not an angle across the face — it is wherever the surface
  turns toward the light, which depends entirely on the shape's curvature.

  That curvature is already solved and sitting in the normal map: R and G
  encode which way the surface faces, neutral at 128 where it is flat. So
  the highlight is a dot product against a light direction, which is
  exactly what feColorMatrix's alpha row computes. With light from the
  upper left that is (0.5 - R) + (0.5 - G), scaled by this constant:
  brightest where the surface tips toward the light, clamped to nothing
  where it tips away, and exactly zero across the flat middle where both
  channels sit at 0.5.

  The scale compensates for the map storing normal *times* bend magnitude
  rather than a unit normal: the rim deviates only about 30/255 at its peak
  and less at the very edge, where the map's own clamp takes the bend to
  zero, so a coefficient near 1 produces a mask of a couple of percent.

  3 rather than the 12 this started at. 12 made a bright white crescent, and
  against the reference that is plainly wrong: there the rim is very nearly
  invisible — the glass is read from the backdrop bending through it and a
  whisper of colour at the very edge, never from a lit ring drawn around it.
  A white arc on a dark bar reads as a halo stuck to the knob rather than as
  light landing on a curve. Kept rather than removed because at this
  strength it still does the one thing dispersion cannot: it tells the eye
  which way the surface is tipped.

  Being derived, it follows any shape for free, and it cannot disagree with
  the bend because both are solved from the same map.
*/
const KNOB_SPECULAR = 3;
/*
  A spectral fringe around the knob's rim, and the one place this app draws
  colour that is not taken from the backdrop.

  That needs saying plainly, because the honest version does not work here.
  Real dispersion separates what is *behind* the glass: a prism has a
  different refractive index per wavelength, so the edge pulls the backdrop's
  own colours apart by different amounts. This filter can express that, and
  did — three displacement passes at three scales, each contributing only its
  own channel. But a split of the backdrop can only show what the backdrop
  has to give, and Light's is a near-flat pale wash. Over that, a physically
  faithful dispersion separates almost nothing and is invisible, which is
  exactly the complaint: the effect is too subtle to see in that theme.

  So the colour is emitted rather than refracted, and only its placement and
  its variation are derived. Where it sits comes from the map's blue channel,
  which now carries how hard the surface is bending — so the fringe lands
  precisely on the turn of the glass and is nothing across the flat middle,
  by construction rather than by tuning a radius. What colour it is at any
  point around that ring comes from the surface normal in R and G: the three
  output channels peak at three different facings, so the hue travels around
  the rim as the surface rotates, the way an edge caustic does. It cannot
  disagree with the bend, because both are read from the same map.

  Kept off the icons for free. The mask is the bend magnitude, and the middle
  of the knob has none — which is the constraint that killed the previous
  attempt at this, where dispersion scaled with a whole-face lens and put
  yellow and magenta on 1.3px monochrome glyphs.
*/
const KNOB_SPECTRUM = 0.85;
/* And the same spectral rim — see KNOB_SPECTRUM. It is masked by the map's
   own bend magnitude, so on a card it lands on the turn at the edge and is
   nothing across the face where the content sits. */
const GENERIC_SPECTRUM = KNOB_SPECTRUM;
/*
  How far the three channels are driven apart. The map's own deviation from
  neutral is small — a rim peaks around 0.12 either side of 0.5 — so a
  coefficient near 1 would produce three nearly identical channels and a grey
  ring. 4 spreads them across most of the range, which is what makes it read
  as a spectrum rather than as a smudge.
*/
const SPECTRUM_SPREAD = 4;
/*
  How sharply the fringe collapses onto the rim. The bend magnitude the mask
  is built from is not itself a rim — the knob's bevel reaches half its
  radius and the whole-face lens leaves some bend nearly everywhere — so
  used raw it paints the whole disc. Raising it to this power keeps the
  geometry deciding where the colour goes while letting only the strongest
  part of it through.
*/
const SPECTRUM_FALLOFF = 3;
/*
  A gentle whole-face lens on top of the rim bevel, so nothing inside the
  knob stays where it was.

  A bevel alone only bends its own band, which is right for a flat pane but
  leaves a line crossing the middle running dead straight — so the same
  line appears twice, bent where it meets the rim and untouched between.
  The reference has no such remnant: everything behind the glass is
  displaced, because the whole face is doing the work rather than only its
  edge.

  This is the `magnify` term the map has always carried and never used: a
  straight ramp along the inward normal, nothing at the centre, growing to
  its full value at the rim. It pulls inward, toward the thick middle, so
  every sample stays on the pane.

  Only the knob. magnify is measured from the centre outward, and on a
  rounded rectangle that traces the panel's own contour some distance into
  the face — the pale shape that got dome and magnify dropped from the
  cards in the first place. On a circle that contour is concentric with the
  knob's own rim, so there is no shape to see: it is the knob. Cards keep
  0 and their bevel.

  Kept small on purpose. Raising it to 0.5 does displace hard — 10px on a
  42px knob — but it drags the rim's own highlight inward across the entire
  face, and the disc turns into a bright wash with the background lost
  behind it. More displacement, less visible refraction. The bevel band is
  the honest lever for making the bend easier to see; this stays a garnish.
*/
const KNOB_MAGNIFY = 0.2;
/*
  The knob eases its bevel's handover to the flat face; cards do not.

  A hard stop at the band's inner edge is a corner in the surface, and on
  the knob it shows plainly: a straight line passing under the rim came
  through bent as far as the band reached and then abruptly straight,
  kinked partway along rather than curving once. Easing removes it — the
  largest jump in slope along a line running inward falls from 11.4x the
  typical jump to 7.6x.

  It is not free: easing costs reach, and a card's slab band goes from 81%
  of the half-width to 70%. That depth is the whole point of the thick
  slab, so cards keep the hard stop. They can afford to — they are large
  and sit over busy backdrops, where the crease has nothing straight
  running under it to reveal itself against.
*/
const KNOB_INNER_EASE = 1;
/* Eased, like the knobs. A hard stop at the band's inner edge is a corner
   in the surface, and on a large pane a straight line crossing it comes
   through bent and then abruptly straight. Cards used to keep the hard stop
   because the slab's reach mattered more; with a narrower band there is no
   depth to protect. */
const GENERIC_INNER_EASE = 1;
const GENERIC_MAGNIFY = 0;
/* No solved highlight on cards, unlike the knobs.

   It is the same dot product against a light in both cases, but a knob is
   42px and a card is hundreds: the arc that reads as a catch of light on a
   small disc becomes a broad bright streak down the side of a large pane,
   and on a dark page that streak is the brightest thing on screen. Reported
   as exactly that. The knobs keep theirs, where it does the job it was
   written for. */
const GENERIC_SPECULAR = 0;
const NAV_ADAPTIVE_TINT = 0.12;
const GENERIC_ADAPTIVE_TINT = 0;
const NAV_TINT_SELECTOR = ".nav-menu-group";
const GENERIC_DISPLACEMENT_HEADROOM = NAV_DISPLACEMENT_HEADROOM;
/* A page with an unusually long list of cards (an admin table, a long
   practice list) could in principle produce more distinct shape buckets than
   is worth generating filters for. This is a safety valve, not an expected
   ceiling — the fixed grid above already holds the real count to at most
   9 x 5 = 45, and most pages use only a handful of shapes. */
const GENERIC_MAX_BUCKETS = 45;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const REDUCED_TRANSPARENCY_QUERY = "(prefers-reduced-transparency: reduce)";

type PerformanceNavigator = Navigator & {
  connection?: {
    saveData?: boolean;
    addEventListener?: typeof addEventListener;
    removeEventListener?: typeof removeEventListener;
  };
  deviceMemory?: number;
};

function createMapUrl(options?: GlassRefractionMapOptions, size = GLASS_REFRACTION_MAP_SIZE) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return null;

  const image = context.createImageData(size, size);
  image.data.set(createGlassRefractionMap(size, options));
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}


/*
  Round a measured shape to a step, rather than snapping it to the nearest of
  a handful of fixed values.

  The grid this replaces held five corner radii, and real cards land between
  them: an account card measures a corner ratio of 0.209 and was served a map
  drawn for 0.12. A bevel solved for one arc and stretched over another has to
  show the seam somewhere, and on a large flat card there is nothing to hide
  it — which is exactly what the lens on cards was removed for.

  Quantising instead of snapping keeps the reason the grid existed. Two cards
  of the same shape still share one filter and one map, because identical
  measurements round identically; what changes is that a shape no longer has
  to be one of five. The steps are fine enough that the residual error is far
  below a pixel of displacement on any real pane, and coarse enough that a
  column of cards differing by a rounding hair does not each get their own.
*/
function quantise(value: number, step: number) {
  return Math.round(value / step) * step;
}

/*
  A pane's corner radius as the browser will actually draw it.

  CSS scales every radius on a box down in proportion when adjacent ones would
  overlap a side — a 40px radius on a 67px-tall card is drawn at 33.6px, not
  40. getComputedStyle reports what was asked for, not what is used, so a map
  solved from it describes a shape the element does not have. On short, wide
  cards that is the single largest source of mismatch there is.
*/
function usedCornerRadius(specified: number, width: number, height: number) {
  if (!(specified > 0)) return 0;
  const shrink = Math.min(1, width / (2 * specified), height / (2 * specified));
  return specified * shrink;
}

type GenericBucket = {
  aspect: number;
  cornerRadius: number;
  bezelWidth: number;
  dispersion: number;
  tint: number;
  specular: number;
  spectrum: number;
  magnify: number;
  innerEase: number;
  scale: number;
};

/* Bezel width is part of the identity, not just the shape: two panes can
   measure to the same rounded rectangle and still want different amounts of
   their face turning over — see KNOB_BEZEL_WIDTH. Keying it here is what
   stops the knob and a square card sharing one filter and one of them
   silently winning. */
function bucketKey(
  aspect: number,
  cornerRadius: number,
  bezelWidth: number,
  dispersion: number,
  tint: number,
  specular: number,
  spectrum: number,
  magnify: number,
  innerEase: number,
) {
  return [aspect, cornerRadius, bezelWidth, dispersion, tint, specular, spectrum, magnify, innerEase]
    .map((value) => value.toFixed(2))
    .join(":");
}

/*
  Every card matching GENERIC_SELECTOR, reduced to the small fixed grid of
  shapes described above it. This keeps one bucket per distinct shape rather
  than collapsing everything to a single median — a square icon tile and a
  wide pricing card are both real, simultaneous shapes on the same page, not
  variations on one card that should share a filter.
*/
function measureGenericPanes(knobsOnly = false) {
  /* On the clone path only the knobs actually use a filter — the cards keep
     ordinary frosted glass there, because a card cannot carry a copy of a
     whole page behind it. Measuring and building maps for every card anyway
     costs a full-size PNG per distinct card shape, decoded and held in
     memory, for filters nothing references. */
  const panes = Array.from(
    document.querySelectorAll<HTMLElement>(knobsOnly ? KNOB_SELECTOR : GENERIC_SELECTOR),
  );
  const buckets = new Map<string, GenericBucket>();
  const assignments = new Map<HTMLElement, string>();

  for (const pane of panes) {
    const { width, height } = pane.getBoundingClientRect();
    if (!(width > 0) || !(height > 0)) continue;

    const specified = Number.parseFloat(getComputedStyle(pane).borderTopLeftRadius) || 0;
    const radius = usedCornerRadius(specified, width, height);
    const halfHeight = height / 2;
    const aspect = quantise(width / height, GENERIC_ASPECT_STEP);
    const cornerRadius = quantise(
      Math.min(radius / halfHeight, 0.98),
      GENERIC_CORNER_STEP,
    );
    const knob = pane.matches(KNOB_SELECTOR);
    const bezelWidth = knob ? KNOB_BEZEL_WIDTH : GENERIC_BEZEL_WIDTH;
    const dispersion = knob ? KNOB_DISPERSION : GENERIC_DISPERSION;
    const tint = pane.matches(NAV_TINT_SELECTOR) ? NAV_ADAPTIVE_TINT : GENERIC_ADAPTIVE_TINT;
    const specular = knob ? KNOB_SPECULAR : GENERIC_SPECULAR;
    const spectrum = knob ? KNOB_SPECTRUM : GENERIC_SPECTRUM;
    const magnify = knob ? KNOB_MAGNIFY : GENERIC_MAGNIFY;
    const innerEase = knob ? KNOB_INNER_EASE : GENERIC_INNER_EASE;
    const key = bucketKey(aspect, cornerRadius, bezelWidth, dispersion, tint, specular, spectrum, magnify, innerEase);
    assignments.set(pane, key);

    if (buckets.has(key) || buckets.size >= GENERIC_MAX_BUCKETS) continue;

    /* Scale depends only on the bucket's own aspect ratio, not its actual
       pixel size: width = aspect * height and halfHeight = height / 2, so
       scale = HEADROOM * halfHeight / diagonal reduces to
       HEADROOM / sqrt(2 * (aspect² + 1)) once height cancels out of both the
       numerator and the diagonal. That is what lets every card sharing a
       bucket also share its filter's fixed scale attribute regardless of how
       large that particular card actually is. */
    const scaleDivisor = Math.sqrt(2 * (aspect * aspect + 1));
    buckets.set(key, {
      aspect,
      cornerRadius,
      bezelWidth,
      dispersion,
      tint,
      specular,
      spectrum,
      magnify,
      innerEase,
      scale: GENERIC_DISPLACEMENT_HEADROOM / scaleDivisor,
    });
  }

  return { buckets, assignments };
}

function isChromium() {
  const browser = navigator as Navigator & {
    userAgentData?: { brands?: Array<{ brand: string }> };
  };
  const brands = browser.userAgentData?.brands?.map(({ brand }) => brand) ?? [];
  const chromiumBrand = brands.some((brand) =>
    /Chromium|Google Chrome|Microsoft Edge|Opera/i.test(brand),
  );
  const chromiumUserAgent = /(?:Chrome|Chromium|Edg|OPR)\//.test(navigator.userAgent)
    && !/CriOS|FxiOS/.test(navigator.userAgent);
  return chromiumBrand || chromiumUserAgent;
}

function supportsLiveBackdropRefraction() {
  /* Safari parses `url(#filter)` in this property but drops the SVG stage at
     paint time. CSS.supports alone would therefore give a false positive and
     can make an iPhone panel disappear. The direct-live path is limited to
     Chromium, whose backdrop compositor actually runs the displacement map. */
  return isChromium() && CSS.supports(
    "backdrop-filter",
    `blur(1px) saturate(100%) url(#${FILTER_ID})`,
  );
}

/*
  An SVG displacement stage is GPU work, not a free opacity tweak. Keep it to
  desktops that have both a fine pointer and enough reported hardware headroom;
  all other devices keep the normal backdrop glass. This is deliberately the
  same eligibility contract as the optional refractive rim, so a page never
  enables one high-detail system while the other has declined it.
*/
function supportsDetailedLiveRefraction() {
  if (!supportsLiveBackdropRefraction()) return false;

  const browser = navigator as PerformanceNavigator;
  return supportsDetailedGlass({
    finePointer: window.matchMedia(GLASS_PERFORMANCE_QUERY).matches,
    reducedMotion: window.matchMedia(REDUCED_MOTION_QUERY).matches,
    reducedTransparency: window.matchMedia(REDUCED_TRANSPARENCY_QUERY).matches,
    saveData: Boolean(browser.connection?.saveData),
    memoryGb: Number.isFinite(browser.deviceMemory) ? browser.deviceMemory ?? null : null,
    cores: Number.isFinite(navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : null,
  });
}

/*
  A second, browser-agnostic eligibility path. `supportsDetailedLiveRefraction`
  above targets the combined `backdrop-filter: blur() url(#id)` syntax, which
  Safari silently drops the SVG stage from — that's a real, narrow WebKit gap,
  not a general "Safari can't do this" limitation. A `filter: url(#id)`
  applied as its OWN property to an element that separately carries its own
  `backdrop-filter: blur()` distorts that element's already-blurred output
  instead. That was believed to run on Safari too; it does not — see
  displacesBackdropContent below for what was measured. It remains the path
  for Chromium contexts the hardware gate above turns away, which is what
  it is now kept for.

  Consumers that use the split-property pattern read this flag instead of
  `supportsDetailedLiveRefraction`'s Chromium-only one. Deliberately no
  fine-pointer or reported-hardware requirement: the whole point is running
  this for every real user regardless of device, not guessing which ones
  have "enough" cores or memory — those guesses are exactly what excluded
  this app's own headless-Chromium test environment (a real, if unusually
  constrained, Chromium browser) during development. It still declines for
  someone who has explicitly asked their OS for reduced motion, reduced
  transparency, or a lighter page on a metered connection — those are
  stated preferences, not a guess about their hardware.
*/
/*
  Whether this engine will displace what is BEHIND an element, as opposed to
  only what the element paints itself.

  This is the question the split-property pattern turns on, and the answer
  for WebKit is no — measured, not assumed. Four arrangements were rendered
  in WebKit against a striped backdrop with a strong radial displacement
  map: `backdrop-filter: url(#lens)`, `backdrop-filter: blur(0px)
  url(#lens)`, the unprefixed form of each, and `filter: url(#lens)` on an
  element separately carrying `backdrop-filter: blur(0px)`. Every one left
  the stripes dead straight. The same markup in Chromium bends them plainly.
  WebKit does apply the filter to an element's own painted content — an
  element given a 1%-white background shows that content being displaced —
  but the backdrop never enters the filter at all.

  So the comment that used to sit here, claiming Safari runs the split
  combination fine, was wrong. What Safari runs fine is a filter over an
  element's own content, which is not what this needs.

  Asked as a positive test for the one engine family known to do it rather
  than as a test against the one known not to. An earlier version keyed off
  a WebKit quirk — Chromium does not implement the *prefixed*
  `-webkit-backdrop-filter` with a url() stage, WebKit does — which
  correctly excluded Safari and then wrongly let Firefox through, since
  Firefox implements neither the prefixed property nor backdrop
  displacement. Naming the engine that works leaves everything else on the
  clone path below, which is the safe side to be wrong on: the clone needs
  nothing of the backdrop compositor.

  There is no way to ask an engine "do you displace backdrops?" — CSS
  parses the declaration either way, and a DOM element's rendered pixels
  cannot be read back — so this is a sniff, deliberately, with the
  measurement it stands in for recorded above it.
*/
function displacesBackdropContent() {
  return isChromium();
}

/*
  The preferences every lens path respects, whichever mechanism it uses.
  These are things a person has asked their operating system for, rather
  than guesses about their hardware.
*/
function lensPreferencesAllow() {
  if (window.matchMedia(REDUCED_MOTION_QUERY).matches) return false;
  if (window.matchMedia(REDUCED_TRANSPARENCY_QUERY).matches) return false;
  return !(navigator as PerformanceNavigator).connection?.saveData;
}

/*
  The path for engines that will not displace a backdrop but will displace
  an element's own painted content — which is WebKit, and therefore every
  browser on iOS, since they all run it.

  Instead of asking the knob to bend what is behind it, the knob carries a
  copy of what is behind it and bends that. The copy is real painted
  content, so WebKit filters it; it is clipped to the knob's disc and offset
  by exactly the knob's own position, so it lands on top of the original
  registered to the pixel. See ThemeToggle and the .theme-knob-refraction
  rules in globals.css.

  What it can bend is the control's own track and icons rather than the
  whole page behind it — a clone can only contain what it is given. On this
  control that is nearly all of the visible detail anyway: the pill's rim
  and the three icons are what a knob passing over them visibly distorts,
  and the header behind is close to a flat colour, which looks the same
  bent or not.
*/
function supportsCloneLens() {
  if (!CSS.supports("filter", `url(#${FILTER_ID})`)) return false;
  if (displacesBackdropContent()) return false;
  return lensPreferencesAllow();
}

function supportsSplitPropertyLens() {
  if (!CSS.supports("filter", `url(#${FILTER_ID})`)) return false;
  if (!displacesBackdropContent()) return false;
  if (window.matchMedia(REDUCED_MOTION_QUERY).matches) return false;
  if (window.matchMedia(REDUCED_TRANSPARENCY_QUERY).matches) return false;

  const browser = navigator as PerformanceNavigator;
  return !browser.connection?.saveData;
}

/*
  The SVG is declared once for the whole document; individual panels only
  reference the stable filter id in CSS, so opening a menu or hovering a
  control never generates a new filter tree. Two eligibility paths share it:
  the combined `backdrop-filter: blur() url(#id)` syntax (Chromium only —
  see supportsDetailedLiveRefraction) and the split filter/backdrop-filter
  pattern (see supportsSplitPropertyLens) that also runs on Safari. Mounted
  whenever either path is eligible, so a consumer using only one of them
  still finds the filter definition in the document.
*/
export default function GlassRefractionFilter() {
  const [mapUrl, setMapUrl] = useState<string | null>(null);
  const [genericFilters, setGenericFilters] = useState<
    Array<{
      key: string;
      id: string;
      url: string;
      scale: number;
      dispersion: number;
      tint: number;
      specular: number;
      spectrum: number;
    }>
  >([]);
  const [enabled, setEnabled] = useState(false);
  const [splitLensEnabled, setSplitLensEnabled] = useState(false);
  const [cloneLensEnabled, setCloneLensEnabled] = useState(false);
  const filterNeeded = enabled || splitLensEnabled || cloneLensEnabled;

  useEffect(() => {
    const media = [
      window.matchMedia(GLASS_PERFORMANCE_QUERY),
      window.matchMedia(REDUCED_MOTION_QUERY),
      window.matchMedia(REDUCED_TRANSPARENCY_QUERY),
    ];
    const connection = (navigator as PerformanceNavigator).connection;
    const update = () => {
      setEnabled(supportsDetailedLiveRefraction());
      setSplitLensEnabled(supportsSplitPropertyLens());
      setCloneLensEnabled(supportsCloneLens());
    };

    update();
    for (const query of media) query.addEventListener("change", update);
    connection?.addEventListener?.("change", update);

    return () => {
      for (const query of media) query.removeEventListener("change", update);
      connection?.removeEventListener?.("change", update);
    };
  }, []);

  useEffect(() => {
    if (!filterNeeded || mapUrl) return;

    /* Same bevel width and displacement headroom as the bucketed system
       below (NAV_BEZEL_WIDTH / NAV_DISPLACEMENT_HEADROOM), so this Chromium
       combined-syntax path — the one plain .liquid-glass and .premade-glass
       panels use — reads as the same strength of glass rather than a softer
       one left on the library's own quieter defaults. */
    const source = createMapUrl({
      bezelWidth: NAV_BEZEL_WIDTH,
      maxDisplacement: NAV_DISPLACEMENT_HEADROOM,
    });
    if (!source) return;

    /* Defer the state update by one paint. This lets the rest of the page
       hydrate first and avoids a synchronous effect-driven render during
       first paint. */
    const frame = requestAnimationFrame(() => setMapUrl(source));
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [filterNeeded, mapUrl]);

  /*
    Every card, bucketed by shape rather than solved per-element (see
    measureGenericPanes). Assignments and filter definitions are rebuilt on
    the same schedule as the nav lens — resize and DOM mutation, since cards
    mount and unmount constantly across the site (route changes, tab
    switches, lists loading) in a way the nav menu's fixed set never does.
  */
  const bucketedLensNeeded = splitLensEnabled || cloneLensEnabled;

  useEffect(() => {
    if (!bucketedLensNeeded) return;

    const known = new Map<
      string,
      {
        id: string;
        url: string;
        scale: number;
        dispersion: number;
        tint: number;
        specular: number;
        spectrum: number;
      }
    >();
    let frame = 0;
    /*
      Ids come from a counter that only ever goes up, never from the cache's
      current size. The cache is pruned below, so a size-derived id would be
      handed out twice: delete one entry and the next shape created takes the
      number a live filter is already using, and every element pointing at it
      silently gets the wrong lens.
    */
    let nextFilterId = 0;

    const rebuild = () => {
      const { buckets, assignments } = measureGenericPanes(cloneLensEnabled && !splitLensEnabled);
      let changed = false;

      for (const [key, bucket] of buckets) {
        if (known.has(key)) continue;

        const source = createMapUrl(
          {
            aspect: bucket.aspect,
            cornerRadius: bucket.cornerRadius,
            bezelWidth: bucket.bezelWidth,
            magnify: bucket.magnify,
            innerEase: bucket.innerEase,
            maxDisplacement: GENERIC_DISPLACEMENT_HEADROOM,
          },
          bucket.bezelWidth === KNOB_BEZEL_WIDTH ? KNOB_MAP_SIZE : GENERIC_MAP_SIZE,
        );
        if (!source) continue;

        nextFilterId += 1;
        known.set(key, {
          id: `${GENERIC_FILTER_PREFIX}-${nextFilterId}`,
          url: source,
          scale: bucket.scale,
          dispersion: bucket.dispersion,
          tint: bucket.tint,
          specular: bucket.specular,
          spectrum: bucket.spectrum,
        });
        changed = true;
      }

      for (const [element, key] of assignments) {
        const entry = known.get(key);
        if (entry) element.style.setProperty("--glass-lens-filter", `url(#${entry.id})`);
      }

      /*
        Forget every shape nothing on the page is standing on any more.

        This cache is keyed by shape, and shapes are measured from live
        elements, so it grows whenever one of them is a different size than
        last time — which the knobs are on every frame of a squash, and every
        pane is while fonts load and the layout settles. Without this the
        cache only ever grew: measured on the home page at one point, four
        shapes were actually in use and fifty-nine filters were mounted, each
        with its own generated map held in memory, none of them referenced.

        Rebuilds are already cheap and rare — resize and DOM mutation — and a
        shape that comes back simply regenerates. Holding one that has gone
        costs a filter tree and a bitmap for nothing.
      */
      const live = new Set(assignments.values());
      for (const key of known.keys()) {
        if (!live.has(key)) {
          known.delete(key);
          changed = true;
        }
      }

      if (changed) {
        setGenericFilters(
          Array.from(known, ([key, entry]) => ({ key, ...entry })),
        );
      }
    };

    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(rebuild);
    };

    schedule();
    window.addEventListener("resize", schedule);
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, [bucketedLensNeeded, cloneLensEnabled, splitLensEnabled]);

  useEffect(() => {
    if (!mapUrl || !enabled) return;

    document.documentElement.dataset.liveGlassRefraction = "";
    return () => {
      delete document.documentElement.dataset.liveGlassRefraction;
    };
  }, [enabled, mapUrl]);

  useEffect(() => {
    if (!mapUrl || !splitLensEnabled) return;

    document.documentElement.dataset.glassLensSplit = "";
    return () => {
      delete document.documentElement.dataset.glassLensSplit;
    };
  }, [splitLensEnabled, mapUrl]);

  useEffect(() => {
    if (!mapUrl || !cloneLensEnabled) return;

    document.documentElement.dataset.glassLensClone = "";
    return () => {
      delete document.documentElement.dataset.glassLensClone;
    };
  }, [cloneLensEnabled, mapUrl]);

  if (!mapUrl || !filterNeeded) return null;

  return (
    <svg
      className="glass-refraction-definitions"
      aria-hidden="true"
      focusable="false"
      width="0"
      height="0"
    >
      <defs>
        {/*
          The region is the pane itself, not a margin around it. A region
          larger than the element lets displaced pixels paint outside its
          own rounded rectangle, which showed up as a faint second copy of
          each card hanging past its bottom-right corner.
        */}
        <filter
          id={FILTER_ID}
          x="0%"
          y="0%"
          width="100%"
          height="100%"
          filterUnits="objectBoundingBox"
          primitiveUnits="objectBoundingBox"
          colorInterpolationFilters="sRGB"
        >
          <feImage
            href={mapUrl}
            x="0"
            y="0"
            width="1"
            height="1"
            preserveAspectRatio="none"
            result="glass-normal-map"
          />
          {/*
            With primitiveUnits="objectBoundingBox" this scale resolves
            against the pane's diagonal, not its shortest side. A navigation
            card is 360x56, so its diagonal is around 258px and a scale of
            0.24 asked for up to 62px of displacement on an element 56px
            tall — more than its whole height, which dragged content from
            outside the card into the middle of it as a hard-edged block.
            The bound that matters is the shortest pane sharing this filter,
            so the value stays small: the glass reads through its rim
            highlight and the bend at its edge, not through a displacement
            large enough to move the backdrop bodily.

            Raised from 0.06 in step with the map's own higher headroom
            above, so this Chromium-only combined path bends its backdrop as
            visibly as the bucketed lens does — still held well under the
            old 0.24 that caused the block-dragging bug, since this one
            scale is shared by every arbitrarily-shaped panel rather than
            solved per shape.
          */}
          <feDisplacementMap
            in="SourceGraphic"
            in2="glass-normal-map"
            scale="0.08"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>

        {/*
          One lens per shape bucket, shared by every card whose measured
          shape snapped to it (see measureGenericPanes). Structurally
          identical to the nav filter above — same physics, just solved for
          a grid of shapes instead of one measured pane.
        */}
        {genericFilters.map((entry) => (
          <filter
            key={entry.key}
            id={entry.id}
            x="0%"
            y="0%"
            width="100%"
            height="100%"
            filterUnits="objectBoundingBox"
            primitiveUnits="objectBoundingBox"
            colorInterpolationFilters="sRGB"
          >
            <feImage
              href={entry.url}
              x="0"
              y="0"
              width="1"
              height="1"
              preserveAspectRatio="none"
              result="generic-normal-map"
            />
            {entry.dispersion > 0 ? (
              <>
                {/*
                  Real dispersion, in place of a painted rainbow.

                  A prism separates because its refractive index depends on
                  wavelength: blue bends hardest, red least. One
                  feDisplacementMap cannot express that — it moves all three
                  channels by a single vector, so it bends without ever
                  separating, which is why the fringe had to be drawn on by
                  hand as a fixed gradient ring.

                  Three passes can. The same normal map, at three scales
                  either side of the true one, and then each pass allowed to
                  contribute only the channel it was solved for: red from the
                  gentlest bend, green from the middle, blue from the
                  strongest. Recombining them gives an edge whose colours
                  come apart the way the reference glass's do — made of
                  whatever is actually behind the pane, so a knob over flat
                  grey shows no fringe at all, and one over a hard edge
                  shows it exactly there.

                  The separation follows the bend, which is already confined
                  to the rim band, so the flat middle disperses nothing.
                */}
                <feDisplacementMap
                  in="SourceGraphic"
                  in2="generic-normal-map"
                  scale={entry.scale * (1 - entry.dispersion)}
                  xChannelSelector="R"
                  yChannelSelector="G"
                  result="lens-red"
                />
                <feDisplacementMap
                  in="SourceGraphic"
                  in2="generic-normal-map"
                  scale={entry.scale}
                  xChannelSelector="R"
                  yChannelSelector="G"
                  result="lens-green"
                />
                <feDisplacementMap
                  in="SourceGraphic"
                  in2="generic-normal-map"
                  scale={entry.scale * (1 + entry.dispersion)}
                  xChannelSelector="R"
                  yChannelSelector="G"
                  result="lens-blue"
                />
                {/*
                  Each matrix keeps one colour channel and passes alpha
                  through untouched. Alpha has to survive: these are
                  composited additively below, and a channel carried on zero
                  alpha is premultiplied away to nothing before it can be
                  added.
                */}
                <feColorMatrix
                  in="lens-red"
                  type="matrix"
                  values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
                  result="only-red"
                />
                <feColorMatrix
                  in="lens-green"
                  type="matrix"
                  values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
                  result="only-green"
                />
                <feColorMatrix
                  in="lens-blue"
                  type="matrix"
                  values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
                  result="only-blue"
                />
                {/*
                  Screen, not an arithmetic sum.

                  Adding them looks like the obvious way to put three
                  single-channel images back together, and it is wrong twice
                  over. feComposite arithmetic works on premultiplied colour,
                  so summing three opaque passes yields alpha 3; converting
                  back to straight colour then divides every channel by that
                  3 and the pane comes out a third as bright. And an image
                  carrying alpha 3 is not well-formed, so anything composited
                  OVER it afterwards is weighted against that 3 and vanishes
                  entirely — which is precisely what silently swallowed the
                  specular stage below, a stage that rendered correctly
                  everywhere it was tested on its own.

                  Screen has neither problem here. Each input has exactly one
                  non-zero channel, so 1-(1-a)(1-b) returns whichever of the
                  two is non-zero, and alpha stays 1 because both inputs are
                  already opaque.
                */}
                <feBlend in="only-red" in2="only-green" mode="screen" result="red-green" />
                <feBlend in="red-green" in2="only-blue" mode="screen" result="lens-out" />
              </>
            ) : (
              <feDisplacementMap
                in="SourceGraphic"
                in2="generic-normal-map"
                scale={entry.scale}
                xChannelSelector="R"
                yChannelSelector="G"
                result="lens-out"
              />
            )}
            {entry.tint > 0 ? (
              <>
                {/*
                  Adaptive tint: the pane answers its own backdrop instead of
                  carrying one fixed fill.

                  luminanceToAlpha turns the sampled, already-bent backdrop
                  into a per-pixel luminance mask. Black flooded through that
                  mask veils wherever the backdrop is bright; white flooded
                  through its inverse — the same mask with the ramp turned
                  over, slope -t and intercept t — lifts wherever it is dark.

                  Both are local, which is the whole point: one pane crossing
                  a hard edge is veiled on the light side and lifted on the
                  dark side at the same time, which no fixed fill can
                  express. Net effect is that contrast under the glass is
                  compressed toward the middle, so whatever sits on top of it
                  stays legible over anything.
                */}
                <feColorMatrix in="lens-out" type="luminanceToAlpha" result="lens-luminance" />
                <feComponentTransfer in="lens-luminance" result="veil-mask">
                  <feFuncA type="linear" slope={entry.tint} intercept="0" />
                </feComponentTransfer>
                <feFlood floodColor="#000000" result="veil-ink" />
                <feComposite in="veil-ink" in2="veil-mask" operator="in" result="veil" />
                <feComponentTransfer in="lens-luminance" result="lift-mask">
                  <feFuncA type="linear" slope={-entry.tint} intercept={entry.tint} />
                </feComponentTransfer>
                <feFlood floodColor="#ffffff" result="lift-light" />
                <feComposite in="lift-light" in2="lift-mask" operator="in" result="lift" />
                <feComposite in="veil" in2="lens-out" operator="over" result="veiled" />
                <feComposite in="lift" in2="veiled" operator="over" result="tinted-out" />
              </>
            ) : null}
            {entry.specular > 0 ? (
              <>
                {/*
                  The highlight, solved from the pane's own curvature — see
                  KNOB_SPECULAR. The alpha row below is the dot product
                  against a light sitting up and to the left; the flood is
                  the light itself, kept only where that dot product is
                  positive.
                */}
                <feColorMatrix
                  in="generic-normal-map"
                  type="matrix"
                  values={`0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  ${-entry.specular} ${-entry.specular} 0 0 ${entry.specular}`}
                  result="specular-mask"
                />
                <feFlood floodColor="#ffffff" result="specular-light" />
                <feComposite
                  in="specular-light"
                  in2="specular-mask"
                  operator="in"
                  result="specular"
                />
                <feComposite
                  in="specular"
                  in2={entry.tint > 0 ? "tinted-out" : "lens-out"}
                  operator="over"
                  result="lit"
                />
              </>
            ) : null}
            {entry.spectrum > 0 ? (
              <>
                {/*
                  The spectral rim — see KNOB_SPECTRUM for why this one is
                  emitted rather than split out of the backdrop.

                  One primitive does all of it, because the map was built to
                  let it. Alpha comes from blue, which carries how hard the
                  surface is bending: nothing across the flat middle, peaking
                  where the glass turns over, so the fringe lands on the rim
                  by construction and never reaches the icons. Colour comes
                  from R and G, the surface normal: the three channels are
                  driven from two different facings and opposite signs, so
                  each peaks at a different point around the ring and the hue
                  travels round it as the surface rotates.

                  The offsets are what keep it centred. Each channel is
                  (value - 0.5) x spread + 0.5, which as a matrix row is the
                  spread in the channel's own column and 0.5 - spread/2 in
                  the constant — so a flat, neutral pixel comes out mid-grey
                  and only deviation from neutral produces colour.
                */}
                <feColorMatrix
                  in="generic-normal-map"
                  type="matrix"
                  values={[
                    `${SPECTRUM_SPREAD} 0 0 0 ${0.5 - SPECTRUM_SPREAD / 2}`,
                    `0 ${SPECTRUM_SPREAD} 0 0 ${0.5 - SPECTRUM_SPREAD / 2}`,
                    `${-SPECTRUM_SPREAD} 0 0 0 ${0.5 + SPECTRUM_SPREAD / 2}`,
                    `0 0 1 0 0`,
                  ].join("  ")}
                  result="spectrum-raw"
                />
                {/*
                  Concentrate the fringe onto the turn of the glass.

                  Alpha out of the matrix above is the raw bend magnitude,
                  and that is not a rim: the knob's bevel reaches half its
                  radius and the whole-face lens on top of it leaves some
                  bend nearly everywhere, so used directly it painted a
                  rainbow across the entire disc — which is both wrong and
                  the exact thing that put colour on the icons last time
                  this was attempted.

                  Raising it to a power fixes that without inventing a
                  radius to clip against: the bend still decides where the
                  colour goes, but only the strongest part of it survives.
                  At 3, half-strength bend keeps an eighth of its alpha
                  and the flat middle keeps none, so the fringe collapses
                  onto the rim where the surface is actually turning
                  hardest. Amplitude carries the overall strength, so the
                  falloff applies to the bend rather than to an
                  already-dimmed value.
                */}
                <feComponentTransfer in="spectrum-raw" result="spectrum">
                  <feFuncA
                    type="gamma"
                    amplitude={entry.spectrum}
                    exponent={SPECTRUM_FALLOFF}
                    offset={0}
                  />
                </feComponentTransfer>
                {/*
                  Painted over rather than screened. Screen is the natural
                  choice for a light on glass and is the wrong one here: the
                  theme this exists for has a near-white backdrop, and
                  screening a colour onto white returns white, which is
                  precisely the invisibility being fixed.
                */}
                <feComposite
                  in="spectrum"
                  in2={
                    entry.specular > 0
                      ? "lit"
                      : entry.tint > 0
                        ? "tinted-out"
                        : "lens-out"
                  }
                  operator="over"
                />
              </>
            ) : null}
          </filter>
        ))}
      </defs>
    </svg>
  );
}
