import type { PlanFigure, PlanMarker } from "@/lib/types";

/*
  The plan a labelling block is answered against.

  Drawn rather than photographed, for the reason the type gives: everything is
  described in a 0-100 square, so the same plan is legible on a phone and on a
  desktop, takes the paper's own colours in every theme, and needs no file to
  be fetched at the moment a candidate is being timed.

  What it is *not* is an interactive map. The exam asks which letter a place is
  at and the candidate answers from the block's bank of letters, so the drawing
  is a thing to read and the letter buttons underneath are the controls. Making
  the markers clickable would be a second way to answer the same question, and
  a second way to answer is a second thing to get wrong on a paper being timed.
*/

/**
 * What this drawing shows, in words.
 *
 * A plan is unreadable to a screen reader, and "map" is not a description. The
 * exam's own accommodation for a candidate who cannot see it is a described
 * alternative, so each letter is placed against the nearest named block —
 * "A, beside the Visitor Centre" — which is what a sighted candidate reads off
 * the drawing anyway. Not a substitute for seeing it, and it does not pretend
 * to be: it is the difference between a task that can be attempted and one
 * that cannot.
 */
function describe(figure: PlanFigure): string {
  const named = figure.areas.filter((area) => area.label);
  const nearest = (marker: PlanMarker) => {
    let best: { label: string; distance: number } | null = null;
    for (const area of named) {
      const cx = area.x + area.w / 2;
      const cy = area.y + area.h / 2;
      const distance = Math.hypot(marker.x - cx, marker.y - cy);
      if (!best || distance < best.distance) best = { label: area.label as string, distance };
    }
    return best?.label;
  };

  const places = named.map((area) => area.label).join(", ");
  const letters = (figure.markers ?? [])
    .map((marker) => {
      const near = nearest(marker);
      return near ? `${marker.key}, beside the ${near}` : marker.key;
    })
    .join("; ");

  return [
    figure.title ? `A plan of ${figure.title}.` : "A plan.",
    places ? `It shows: ${places}.` : "",
    figure.entrance ? `The way in is marked ${figure.entrance.label}.` : "",
    letters ? `Lettered positions: ${letters}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export default function PlanDrawing({ figure }: { figure: PlanFigure }) {
  return (
    <figure className="card overflow-hidden">
      {figure.title && (
        <figcaption className="mb-3 text-center text-sm font-semibold text-slate-900">
          {figure.title}
        </figcaption>
      )}
      <svg
        viewBox="0 0 100 100"
        /*
          A fixed aspect, and the drawing is authored to fill it. Letting the
          box stretch would move the letters relative to the blocks they are
          beside, which on this task is the answer.
        */
        className="mx-auto block h-auto w-full max-w-lg"
        role="img"
        aria-label={describe(figure)}
      >
        {figure.routes?.map((route, index) => (
          <polyline
            key={`route-${index}`}
            points={route.points.map((point) => `${point.x},${point.y}`).join(" ")}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.28}
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

        {figure.areas.map((area, index) => (
          <g key={`area-${index}`}>
            <rect
              x={area.x}
              y={area.y}
              width={area.w}
              height={area.h}
              rx={1.5}
              fill="currentColor"
              fillOpacity={area.label ? 0.07 : 0.04}
              stroke="currentColor"
              strokeOpacity={0.3}
              strokeWidth={0.5}
            />
            {area.label && (
              <text
                x={area.x + area.w / 2}
                y={area.y + area.h / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={3.4}
                fill="currentColor"
                fillOpacity={0.75}
              >
                {area.label}
              </text>
            )}
          </g>
        ))}

        {figure.entrance && (
          <text
            x={figure.entrance.x}
            y={figure.entrance.y}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={3.2}
            fontStyle="italic"
            fill="currentColor"
            fillOpacity={0.7}
          >
            {figure.entrance.label}
          </text>
        )}

        {(figure.markers ?? []).map((marker) => (
          <g key={marker.key}>
            {/*
              A filled disc rather than an outline. The letters sit on top of
              blocks as often as beside them, and an outlined marker over a
              filled rectangle is two overlapping edges where the candidate
              needs one legible character.
            */}
            <circle cx={marker.x} cy={marker.y} r={4} fill="currentColor" fillOpacity={0.92} />
            <text
              x={marker.x}
              y={marker.y}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={4.4}
              fontWeight={700}
              fill="var(--exam-bg, var(--color-surface))"
            >
              {marker.key}
            </text>
          </g>
        ))}
      </svg>
    </figure>
  );
}
