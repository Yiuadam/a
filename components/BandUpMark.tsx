/*
  The app mark, drawn rather than fetched, so it can take a colour per theme.

  It was a 108px PNG render of the rear layer with the glass rim laid over it in
  SVG. That is one colourway and cannot become three: a raster is fixed at the
  colours it was rendered with, and the only way to move them is a filter, which
  turns a considered palette into whatever hue-rotate happens to produce.

  This is the same design from the vector master the icon family was built from
  (public/icons/final/steps-five-flat.svg) — five steps, a second sheet turned
  behind them, the ruled lines cut out of the paper rather than painted on it —
  with every colour read from a custom property. Warm keeps the palette the mark
  has always had; Light and Dark set their own in app/globals.css. The glass rim
  that used to sit on top still sits on top, unchanged, in SiteHeader.

  Crisper as a side effect: the PNG was a 108px source shown at 36 and scaled on
  a retina screen; this is resolution-free.
*/
export default function BandUpMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" className={className} aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="bandup-mark-ground" cx="0.3" cy="0.75" r="0.95">
          <stop offset="0" stopColor="var(--mark-ground-near)" />
          <stop offset="1" stopColor="var(--mark-ground-far)" />
        </radialGradient>
        <linearGradient id="bandup-mark-paper" x1="0.1" y1="1" x2="0.9" y2="0">
          <stop offset="0" stopColor="var(--mark-paper-shade)" />
          <stop offset="0.55" stopColor="var(--mark-paper-mid)" />
          <stop offset="1" stopColor="var(--mark-paper-light)" />
        </linearGradient>
        <linearGradient id="bandup-mark-sheet" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--mark-sheet-light)" />
          <stop offset="1" stopColor="var(--mark-sheet-shade)" />
        </linearGradient>
        {/*
          The ruled lines are holes in the paper, not marks on it — the same
          decision the master made, and the reason they pick up whatever is
          behind the sheet instead of needing a colour of their own.
        */}
        <mask id="bandup-mark-ruled">
          <rect width="1024" height="1024" fill="#fff" />
          <rect x="304" y="690" width="404" height="26" rx="13" fill="#000" />
          <rect x="304" y="762" width="286" height="26" rx="13" fill="#000" />
        </mask>
      </defs>

      <rect width="1024" height="1024" fill="url(#bandup-mark-ground)" />

      <rect
        x="272"
        y="300"
        width="500"
        height="546"
        rx="26"
        fill="url(#bandup-mark-sheet)"
        transform="rotate(-13 512 560)"
      />

      <g transform="rotate(4 512 560)">
        <path
          d="M 254 866 L 254 700 L 370 700 L 370 604 L 486 604 L 486 496
             L 602 496 L 602 384 L 718 384 L 718 254 L 794 254 L 794 866 Z"
          transform="translate(20 24)"
          fill="var(--mark-shadow)"
          opacity="0.45"
        />
        <path
          d="M 254 866 L 254 700 L 370 700 L 370 604 L 486 604 L 486 496
             L 602 496 L 602 384 L 718 384 L 718 254 L 794 254 L 794 866 Z"
          fill="url(#bandup-mark-paper)"
          mask="url(#bandup-mark-ruled)"
        />
      </g>
    </svg>
  );
}
