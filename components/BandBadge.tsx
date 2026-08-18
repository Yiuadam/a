import { bandLabel, cefrEstimate } from "@/lib/band";

/*
  The most repeated element in the app, so it earns a little more than a filled
  circle with a number in it: the ring around the disc is the band placed on the
  1–9 scale. A learner sitting at 5.5 can see at a glance that they are a little
  past halfway, which the bare numeral never told them.

  Drawn in SVG with `stroke` bound to the theme variables, so all three themes
  come out right without a single `dark:` prefix.
*/
const SIZES = {
  lg: { box: 96, stroke: 7, gap: 6, text: "text-3xl" },
  sm: { box: 48, stroke: 4, gap: 3, text: "text-base" },
} as const;

export default function BandBadge({
  band,
  size = "lg",
  caption,
}: {
  band: number;
  size?: "sm" | "lg";
  caption?: string;
}) {
  const s = SIZES[size];
  const radius = (s.box - s.stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  // Band 1 is the floor of the scale, not zero, so the ring starts empty at 1.
  const progress = Math.max(0, Math.min(1, (band - 1) / 8));
  const inset = s.stroke + s.gap;

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative shrink-0" style={{ width: s.box, height: s.box }}>
        <svg
          viewBox={`0 0 ${s.box} ${s.box}`}
          className="absolute inset-0 -rotate-90"
          aria-hidden
        >
          <circle
            cx={s.box / 2}
            cy={s.box / 2}
            r={radius}
            fill="none"
            stroke="var(--color-indigo-100)"
            strokeWidth={s.stroke}
          />
          <circle
            cx={s.box / 2}
            cy={s.box / 2}
            r={radius}
            fill="none"
            stroke="var(--color-indigo-500)"
            strokeWidth={s.stroke}
            strokeLinecap="round"
            strokeDasharray={`${circumference * progress} ${circumference}`}
          />
        </svg>
        <div
          className={`band-disc absolute flex items-center justify-center rounded-full font-bold tabular-nums text-accent-fg ${s.text}`}
          style={{ inset }}
        >
          {band.toFixed(band % 1 === 0 ? 0 : 1)}
        </div>
      </div>
      {size === "lg" && (
        <div className="text-center">
          <div className="text-sm font-medium text-slate-800">{bandLabel(band)}</div>
          <div className="text-xs text-slate-500">
            {caption ?? `Roughly CEFR ${cefrEstimate(band)}`}
          </div>
        </div>
      )}
    </div>
  );
}
