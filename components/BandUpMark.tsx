"use client";

import { useId } from "react";

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

  No shadow. One was tried and taken out: the two sheets read as two sheets
  from their colours alone, the mark is drawn at 36px in the header where a
  blur is mud, and the layer notes are explicit that a second shadow over the
  system's own reads as a smudge.

  The two sheets carry classes so app/globals.css can lift them apart on hover
  — the layers are real elements now, which is what makes that possible at all.
  It used to be a raster tile with a second SVG over it, and the second SVG was
  drawn to a different viewBox: what separated was not the artwork.
*/
export default function BandUpMark({ className = "" }: { className?: string }) {
  /*
    A gradient id unique to this instance.

    `url(#…)` resolves against the whole document, so two marks on one page both
    painted with the first one's gradient — and the first one's gradient reads
    *its* element's custom properties. Rendered side by side in different themes
    that showed as a blue mark on a brown ground: the sheet took its own colour
    and the ground took the neighbour's. One mark on a page hid it; it was still
    wrong.
  */
  /*
    Ids unique to this instance. `url(#…)` resolves against the whole document,
    so two marks on one page both painted with the first one's gradient — and
    that gradient reads *its* element's custom properties. Rendered side by side
    in different themes it showed as a blue mark on a brown ground.
  */
  const id = useId();
  const gradient = `bandup-mark-ground-${id}`;
  const ruled = `bandup-mark-ruled-${id}`;
  return (
    <svg viewBox="0 0 1024 1024" className={className} aria-hidden="true" focusable="false">
      <defs>
        {/*
          A linear gradient on the diagonal, not a radial wash: the material's
          own lighting runs top-left to bottom-right and a gradient in the same
          direction harmonises with it, where a radial puts its light in the
          middle and fights it. Straight from the layer's own notes.
        */}
        <linearGradient id={gradient} x1="0" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor="var(--mark-ground-near)" />
          <stop offset="0.55" stopColor="var(--mark-ground-mid)" />
          <stop offset="1" stopColor="var(--mark-ground-far)" />
        </linearGradient>
      </defs>

      {/* Layer 1. Edge to edge and opaque; no rounded corners, because the
          header rounds the tile itself and baking a second mask in doubles the
          corner. */}
      <rect width="1024" height="1024" fill={`url(#${gradient})`} />

      {/* Layer 2, the sheet turned behind the page. Flat, not gradient: the
          depth is meant to come from the layers being separate. */}
      {/*
        The rotation lives on the group and the class on the shape, so the hover
        transform composes inside it. A CSS `transform` replaces an element's
        own `transform` attribute rather than adding to it — put both on one
        element and the sheet snaps square the moment a pointer arrives.
      */}
      <g transform="rotate(-13 512 560)">
        <rect
          className="bandup-sheet-back"
          x="272"
          y="300"
          width="500"
          height="546"
          rx="26"
          fill="var(--mark-sheet)"
        />
      </g>

      {/*
        Layer 3, the page — with the ruled lines cut out of it rather than drawn
        on top, which is the thing that makes this design what it is.

        A mask, not an `evenodd` hole, and the difference is not stylistic. The
        sheet is a staircase: above y=700 its left edge is the step at x=370,
        not x=254. An `evenodd` sub-path that starts left of the sheet does not
        stop at the outline — it draws a hole in mid-air and opens onto the
        ground. A mask only removes where the sheet already is, so the same
        rectangle can start at x=304 and simply have no effect where there is
        no paper. That is how the master does it, and it is why the master's
        rules can sit where they look right rather than where the geometry
        permits.

        Both rules 26 units tall with a 13 radius, at y=690 and y=762 — the
        master's own numbers, not re-derived.
      */}
      <mask id={ruled}>
        <rect width="1024" height="1024" fill="#fff" />
        <rect x="304" y="690" width="404" height="26" rx="13" fill="#000" />
        <rect x="304" y="762" width="286" height="26" rx="13" fill="#000" />
      </mask>
      <g transform="rotate(4 512 560)">
        <path
          className="bandup-sheet-front"
          fill="var(--mark-paper)"
          mask={`url(#${ruled})`}
          d="M 254 866 L 254 700 L 370 700 L 370 604 L 486 604 L 486 496
             L 602 496 L 602 384 L 718 384 L 718 254 L 794 254 L 794 866 Z"
        />
      </g>
    </svg>
  );
}
