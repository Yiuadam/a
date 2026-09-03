/*
  The app mark: the Liquid Glass design, drawn, so it can take a colour per
  theme.

  The three layers are the ones meant to ship — public/icons/final/glass/
  01-background, 02-back-sheet and 03-front-sheet — reproduced here rather than
  fetched, and with every colour read from a custom property. The flat icon in
  that same folder is the control the family was designed against and is not
  this: its ground is a radial wash and its sheets carry gradients to fake the
  depth that the glass version gets from actually being three layers.

  Why drawn at all: it was a 108px PNG, which is one colourway. The app has
  three themes, and the only way to move a raster's colours is a filter — which
  turns a chosen palette into whatever hue-rotate happens to give. Warm keeps
  the values the layers were drawn with; Light and Dark set their own in
  app/globals.css.

  What is deliberately not here is the specular rim and the per-layer shadow.
  On a device the system draws those; in the header SiteHeader lays its own
  approximation over the top (`bandup-mark-front`), which is where it was
  before and where it stays. Painting a second set here would be the smudge the
  layer notes warn about.
*/
export default function BandUpMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" className={className} aria-hidden="true" focusable="false">
      <defs>
        {/*
          A linear gradient on the diagonal, not a radial wash: the material's
          own lighting runs top-left to bottom-right and a gradient in the same
          direction harmonises with it, where a radial puts its light in the
          middle and fights it. Straight from the layer's own notes.
        */}
        <linearGradient id="bandup-mark-ground" x1="0" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor="var(--mark-ground-near)" />
          <stop offset="0.55" stopColor="var(--mark-ground-mid)" />
          <stop offset="1" stopColor="var(--mark-ground-far)" />
        </linearGradient>
      </defs>

      {/* Layer 1. Edge to edge and opaque; no rounded corners, because the
          header rounds the tile itself and baking a second mask in doubles the
          corner. */}
      <rect width="1024" height="1024" fill="url(#bandup-mark-ground)" />

      {/* Layer 2, the sheet turned behind the page. Flat, not gradient: the
          depth is meant to come from the layers being separate. */}
      <rect
        x="272"
        y="300"
        width="500"
        height="546"
        rx="26"
        fill="var(--mark-sheet)"
        transform="rotate(-13 512 560)"
      />

      {/* Layer 3, the page — with the ruled lines cut out of it rather than
          drawn on top, which is the thing that makes this design what it is.
          One path with `evenodd`, so the rules are holes and pick up the sheet
          behind them. */}
      <path
        transform="rotate(4 512 560)"
        fill="var(--mark-paper)"
        fillRule="evenodd"
        d="M 254 866 L 254 700 L 370 700 L 370 604 L 486 604 L 486 496
           L 602 496 L 602 384 L 718 384 L 718 254 L 794 254 L 794 866 Z
           M 304 684 H 688 A 20 20 0 0 1 688 724 H 304 A 20 20 0 0 1 304 684 Z
           M 304 754 H 570 A 20 20 0 0 1 570 794 H 304 A 20 20 0 0 1 304 754 Z"
      />
    </svg>
  );
}
