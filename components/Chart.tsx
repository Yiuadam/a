"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import {
  barPath,
  chartProblems,
  chartSummary,
  formatNumber,
  formatValue,
  lastReading,
  lineRuns,
  markerPath,
  percentOf,
  pieLabels,
  pieSlices,
  seriesColor,
  seriesMarker,
  stackSegments,
  stackTotals,
  sumValues,
  textWidth,
  valueScale,
  wedgePath,
  type BarChartSpec,
  type ChartSpec,
  type LineChartSpec,
  type MarkerShape,
  type Scale,
} from "@/lib/chart";

/*
  Writing Task 1 as SVG.

  Three rules shape nearly every decision below.

  Theme. Nothing is painted with a literal colour. Every fill and stroke is a
  `var(--color-…)` the theme redefines on <html data-theme>, so a chart follows
  Warm, Light and Dark without this file knowing which is on — and so
  `text-slate-900` keeps meaning "the strongest text" even in Dark, where the
  ramp is inverted.

  Width. The app has no `overflow-x: hidden`, so a chart that is too wide drags
  the whole page sideways rather than being clipped. This one measures the space
  it is given and draws to it: one SVG user unit is one CSS pixel, which is also
  what keeps a 12px label 12px on a phone instead of shrinking with the picture.
  Before the first measurement — on the server, and for the first client frame —
  it draws at a sensible default and scales down to fit, so it cannot overflow
  even then. The narrowest real case is about 255px: a 375px phone, less the
  page gutters, a card and the prompt box inside it.

  Access. A candidate using a screen reader still has to sit the task, so the
  figures are never only in the picture. The SVG carries a title and a
  description with real numbers in it, and the same figures are set out again in
  a table under the chart — which is also the escape hatch when a label will not
  fit, and the reason nothing here is ever silently dropped.
*/

/** Before the first measurement. The SVG scales to fit, so this is never wrong. */
const FALLBACK_WIDTH = 560;
/** A card inside a card inside a 375px phone. */
const MIN_WIDTH = 240;
/**
 * A chart stops growing here and centres in whatever space is left.
 *
 * Bars are capped at 24px so they never fill their slot, which is right — but
 * on a desktop that leaves three hairlines stranded in 1,200 pixels, and the
 * comparison the task is asking about stops being visible. A Task 1 figure is
 * a figure, not a banner.
 */
const MAX_WIDTH = 640;

const GRID = "var(--color-slate-200)";
const AXIS = "var(--color-slate-300)";
const INK = "var(--color-slate-500)";
const STRONG_INK = "var(--color-slate-700)";
/**
 * What the gaps and rings are painted with — the colour behind the chart.
 *
 * A card is `bg-surface`, which is the usual case and the default. A chart set
 * on some other background says so with the CSS variable rather than a prop:
 * `<Chart className="[--chart-surface:var(--color-slate-50)]" … />`, which is
 * exactly what the prompt box on the writing page will need.
 */
const SURFACE = "var(--chart-surface, var(--color-surface))";

/** The gap in the surface colour that separates touching marks. */
const GAP = 2;

type Cartesian = LineChartSpec | BarChartSpec;

// ---------------------------------------------------------------- measuring ---

/** The width of the box the chart has been given, tracked as it changes. */
function useMeasuredWidth(): [number, RefObject<HTMLDivElement | null>] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0;
      if (measured > 0) setWidth(Math.max(MIN_WIDTH, Math.round(measured)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [width, ref];
}

// ------------------------------------------------------------------- frame ---

interface Frame {
  width: number;
  height: number;
  left: number;
  top: number;
  plotW: number;
  plotH: number;
  font: number;
  scale: Scale;
  /** Centre of category `i` — the tick on a line, the group on a bar chart. */
  xAt: (i: number) => number;
  yAt: (v: number) => number;
  /** Width of one category's share of the axis. */
  slot: number;
  /** Category labels slanted, because upright they would collide. */
  rotate: boolean;
  /** Which category labels are drawn; a line axis thins them rather than slanting. */
  showLabel: boolean[];
  labelText: (i: number) => string;
}

/** Slanted labels get shortened rather than allowed to eat the plot. */
const ROTATED_LABEL_CHARS = 14;
const SLANT = 35;
const SLANT_X = Math.cos((SLANT * Math.PI) / 180);
const SLANT_Y = Math.sin((SLANT * Math.PI) / 180);

function buildFrame(spec: Cartesian, width: number, plotCap = 260): Frame {
  const font = width < 340 ? 11 : 12;
  const count = Math.max(1, spec.categories.length);
  const scale = valueScale(spec, width < 340 ? 4 : 5);

  const tickWidth = Math.max(0, ...scale.ticks.map((t) => textWidth(formatNumber(t), font)));
  const baseLeft = (spec.yLabel ? font + 4 : 0) + tickWidth + 8;

  // A line's last tick sits on the right edge of the plot, so half its label
  // hangs past it; a single-series line also carries its value at the end.
  const lastCategory = spec.categories[count - 1] ?? "";
  let right = 10;
  if (spec.kind === "line") {
    right = Math.max(right, textWidth(lastCategory, font) / 2 + 2);
    if (spec.series.length === 1) {
      const end = lastReading(spec.series[0]?.values ?? []);
      if (end) right = Math.max(right, textWidth(formatValue(end.value, spec.unit), font) + 10);
    }
  }

  const isLine = spec.kind === "line";
  const provisionalPlotW = Math.max(40, width - baseLeft - right);
  const slotOf = (plotW: number) => (isLine && count > 1 ? plotW / (count - 1) : plotW / count);

  const longest = Math.max(0, ...spec.categories.map((c) => textWidth(c, font)));
  // A line axis is ordered, so dropping every other year still reads. A bar
  // axis is not — each bar needs its own name — so those labels slant instead.
  const rotate = !isLine && longest > slotOf(provisionalPlotW) - 6;
  const labelText = (i: number) => {
    const raw = spec.categories[i] ?? "";
    if (!rotate || raw.length <= ROTATED_LABEL_CHARS) return raw;
    return `${raw.slice(0, ROTATED_LABEL_CHARS - 1)}…`;
  };

  const rotatedWidth = rotate
    ? Math.max(0, ...spec.categories.map((_, i) => textWidth(labelText(i), font)))
    : 0;
  // A slanted label runs down and to the left of its tick, so only the first
  // one can fall off the left edge — reserving room for the widest label
  // instead would push the plot sideways for nothing.
  const overhang = rotate
    ? Math.max(0, textWidth(labelText(0), font) * SLANT_X - slotOf(provisionalPlotW) / 2)
    : 0;
  const left = Math.ceil(baseLeft + Math.min(overhang, width * 0.3));
  const plotW = Math.max(40, width - left - right);

  const showLabel = isLine
    ? thinLabels(spec.categories, plotW, font)
    : spec.categories.map(() => true);

  const axisDepth = rotate ? 10 + rotatedWidth * SLANT_Y : font + 8;
  const bottom = axisDepth + (spec.xLabel ? font + 8 : 0) + 4;
  const top = 16;
  /*
    Bounded by `plotCap`, which the owner's console lowers.

    Left to itself a wide panel draws a 260-pixel plot, and two of those turned
    the dashboard into a page that had to be scrolled the moment there was
    anything to plot — the switch and the checklist were pushed under the fold
    by data arriving, which is the one thing a glanceable screen must not do.

    A cap rather than scaling the finished drawing down: shrinking the SVG
    shrinks its type with it, and a seven-pixel axis label is not a smaller
    chart, it is an unreadable one. This makes the plot shorter and leaves
    every label the size it was.
  */
  const plotH = Math.round(Math.min(plotCap, Math.max(90, width * 0.5)));
  const height = Math.ceil(top + plotH + bottom);

  const slot = slotOf(plotW);
  const span = scale.max - scale.min || 1;

  return {
    width,
    height,
    left,
    top,
    plotW,
    plotH,
    font,
    scale,
    slot,
    rotate,
    showLabel,
    labelText,
    xAt: (i) => (isLine && count > 1 ? left + (plotW * i) / (count - 1) : left + slot * (i + 0.5)),
    yAt: (v) => top + plotH - ((v - scale.min) / span) * plotH,
  };
}

/**
 * Which labels a line axis can afford to print. Every k-th one plus the last,
 * with the neighbour dropped when the last would land on top of it.
 */
function thinLabels(categories: string[], plotW: number, font: number): boolean[] {
  const count = categories.length;
  if (count <= 1) return categories.map(() => true);
  const needed = Math.max(0, ...categories.map((c) => textWidth(c, font))) + 10;
  const step = Math.max(1, Math.ceil(needed / (plotW / (count - 1))));
  const show = categories.map((_, i) => i % step === 0);
  const lastRegular = Math.floor((count - 1) / step) * step;
  if (lastRegular > 0 && count - 1 - lastRegular < step) show[lastRegular] = false;
  show[count - 1] = true;
  return show;
}

// ---------------------------------------------------------- shared drawing ---

function Grid({ frame, spec }: { frame: Frame; spec: Cartesian }) {
  const { left, plotW, plotH, top, font, scale } = frame;
  const zeroY = scale.min <= 0 && scale.max >= 0 ? frame.yAt(0) : top + plotH;
  return (
    <g aria-hidden="true">
      {scale.ticks.map((tick) => (
        <line
          key={tick}
          x1={left}
          x2={left + plotW}
          y1={frame.yAt(tick)}
          y2={frame.yAt(tick)}
          stroke={GRID}
          strokeWidth={1}
        />
      ))}
      {scale.ticks.map((tick) => (
        <text
          key={tick}
          x={left - 6}
          y={frame.yAt(tick) + font * 0.35}
          textAnchor="end"
          fontSize={font}
          fill={INK}
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {formatNumber(tick)}
        </text>
      ))}
      <line x1={left} x2={left + plotW} y1={zeroY} y2={zeroY} stroke={AXIS} strokeWidth={1} />
      {spec.yLabel && (
        <text
          x={font}
          y={top + plotH / 2}
          fontSize={font}
          fill={INK}
          textAnchor="middle"
          transform={`rotate(-90, ${font}, ${top + plotH / 2})`}
        >
          {spec.yLabel}
        </text>
      )}
      {spec.xLabel && (
        <text
          x={left + plotW / 2}
          y={frame.height - 4}
          fontSize={font}
          fill={INK}
          textAnchor="middle"
        >
          {spec.xLabel}
        </text>
      )}
    </g>
  );
}

function CategoryLabels({ frame }: { frame: Frame }) {
  const { top, plotH, font, rotate, showLabel } = frame;
  const baseline = top + plotH;
  return (
    <g aria-hidden="true">
      {showLabel.map((show, i) => {
        if (!show) return null;
        const x = frame.xAt(i);
        const label = frame.labelText(i);
        if (!label) return null;
        return rotate ? (
          <text
            key={i}
            x={x}
            y={baseline + 10}
            fontSize={font}
            fill={INK}
            textAnchor="end"
            transform={`rotate(-${SLANT}, ${x}, ${baseline + 10})`}
          >
            {label}
          </text>
        ) : (
          <text key={i} x={x} y={baseline + font + 4} fontSize={font} fill={INK} textAnchor="middle">
            {label}
          </text>
        );
      })}
    </g>
  );
}

// ------------------------------------------------------------------- line ---

function LinePlot({ spec, frame }: { spec: LineChartSpec; frame: Frame }) {
  return (
    <>
      {spec.series.map((series, s) => {
        const colour = seriesColor(s);
        const runs = lineRuns(series.values);
        return (
          <g key={s}>
            {runs.map((run, r) =>
              run.length < 2 ? null : (
                <path
                  key={r}
                  d={run
                    .map(
                      (reading, i) =>
                        `${i ? "L" : "M"} ${frame.xAt(reading.index).toFixed(1)} ${frame
                          .yAt(reading.value)
                          .toFixed(1)}`,
                    )
                    .join(" ")}
                  fill="none"
                  stroke={colour}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ),
            )}
            {runs.flat().map((reading) => (
              <path
                key={reading.index}
                // The ring keeps a marker readable where two series cross. It is
                // drawn in the surface colour, so it reads as a gap rather than
                // as an outline around the mark.
                d={markerPath(seriesMarker(s), frame.xAt(reading.index), frame.yAt(reading.value), 4)}
                fill={colour}
                stroke={SURFACE}
                strokeWidth={GAP}
              />
            ))}
          </g>
        );
      })}
      {spec.series.length === 1 && <EndLabel spec={spec} frame={frame} />}
    </>
  );
}

/**
 * One series has no legend — the title already names it — so it gets its value
 * at the end of the line instead. With two or more the labels would collide on
 * a phone, and there the legend and the table carry identity and figures.
 */
function EndLabel({ spec, frame }: { spec: LineChartSpec; frame: Frame }) {
  const end = lastReading(spec.series[0]?.values ?? []);
  if (!end) return null;
  return (
    <text
      x={frame.xAt(end.index) + 8}
      y={frame.yAt(end.value) + frame.font * 0.35}
      fontSize={frame.font}
      fontWeight={600}
      fill={STRONG_INK}
    >
      {formatValue(end.value, spec.unit)}
    </text>
  );
}

// -------------------------------------------------------------------- bar ---

function GroupedBars({ spec, frame }: { spec: BarChartSpec; frame: Frame }) {
  const count = spec.series.length;
  const band = frame.slot * 0.74;
  const barWidth = Math.max(3, Math.min(24, (band - GAP * (count - 1)) / count));
  const groupWidth = barWidth * count + GAP * (count - 1);
  const baseline = frame.yAt(Math.max(frame.scale.min, Math.min(0, frame.scale.max)));
  // Only a single series can be labelled on the cap without the numbers
  // colliding. The label is centred on the bar and may be wider than it, so
  // what it has to clear is the slot, not the bar.
  const capLabels =
    count === 1 && textWidth(formatNumber(frame.scale.max), frame.font) <= frame.slot - 8;

  return (
    <>
      {spec.series.map((series, s) => (
        <g key={series.name}>
          {series.values.map((value, i) => {
            if (value === null || value === undefined) return null;
            const x = frame.xAt(i) - groupWidth / 2 + s * (barWidth + GAP);
            const y = frame.yAt(value);
            return (
              <g key={i}>
                <path d={barPath(x, baseline, y, barWidth)} fill={seriesColor(s)} />
                {capLabels && (
                  <text
                    x={x + barWidth / 2}
                    y={(value >= 0 ? y - 5 : y + frame.font + 3)}
                    fontSize={frame.font}
                    fill={STRONG_INK}
                    textAnchor="middle"
                  >
                    {formatNumber(value)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      ))}
    </>
  );
}

function StackedBars({ spec, frame }: { spec: BarChartSpec; frame: Frame }) {
  const barWidth = Math.min(48, frame.slot * 0.6);
  const baseline = frame.yAt(0);
  const totals = stackTotals(spec);

  return (
    <>
      {spec.categories.map((category, i) => {
        const x = frame.xAt(i) - barWidth / 2;
        return (
          <g key={i}>
            {stackSegments(spec, i).map((segment) => {
              const foot = frame.yAt(segment.from);
              // Every segment but the topmost gives up 2px at its head, and
              // that strip of surface is what separates it from the one above.
              const head = frame.yAt(segment.to) + (segment.isTop ? 0 : GAP);
              if (foot - head <= 0.5) return null;
              return (
                <path
                  key={segment.seriesIndex}
                  d={barPath(x, foot, head, barWidth, segment.isTop ? 4 : 0)}
                  fill={seriesColor(segment.seriesIndex)}
                />
              );
            })}
            <text
              x={x + barWidth / 2}
              y={frame.yAt(totals[i]) - 5}
              fontSize={frame.font}
              fill={STRONG_INK}
              textAnchor="middle"
            >
              {formatNumber(totals[i])}
            </text>
            {/* Anchors the stack even when its first segment is a hairline. */}
            <line x1={x} x2={x + barWidth} y1={baseline} y2={baseline} stroke={AXIS} strokeWidth={1} />
          </g>
        );
      })}
    </>
  );
}

// -------------------------------------------------------------------- pie ---

const PIE_LABEL_ROOM = 34;

function PiePlot({
  spec,
  width,
  titleId,
  descId,
}: {
  spec: ChartSpec;
  width: number;
  titleId: string;
  descId: string;
}) {
  const font = width < 340 ? 11 : 12;
  const radius = Math.max(48, Math.min((width - 2 * PIE_LABEL_ROOM) / 2, 120));
  const height = Math.ceil(2 * radius + 2 * PIE_LABEL_ROOM);
  const cx = width / 2;
  const cy = height / 2;
  const slices = pieSlices(spec);

  return (
    <svg
      role="img"
      aria-labelledby={`${titleId} ${descId}`}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className="h-auto w-full"
    >
      <title id={titleId}>{spec.title}</title>
      <desc id={descId}>{chartSummary(spec)}</desc>
      {slices.map((slice, i) =>
        slice.end - slice.start <= 0 ? null : (
          <path
            key={i}
            d={wedgePath(cx, cy, radius, slice.start, slice.end)}
            fill={seriesColor(i)}
            // A stroke in the surface colour, shared between neighbours: the
            // 2px gap that separates one slice from the next.
            stroke={SURFACE}
            strokeWidth={GAP}
          />
        ),
      )}
      {pieLabels(slices, cx, cy, radius, font).map((label) => (
        <text
          key={label.category}
          x={label.x}
          y={label.y}
          fontSize={font}
          fill={INK}
          textAnchor={label.anchor}
        >
          {label.text}
        </text>
      ))}
    </svg>
  );
}

// ----------------------------------------------------------------- legend ---

function LegendSwatch({ index, kind }: { index: number; kind: ChartSpec["kind"] }) {
  const colour = seriesColor(index);
  if (kind === "line") {
    const shape: MarkerShape = seriesMarker(index);
    return (
      <svg width={20} height={12} viewBox="0 0 20 12" aria-hidden="true" className="shrink-0">
        <line x1={1} x2={19} y1={6} y2={6} stroke={colour} strokeWidth={2} strokeLinecap="round" />
        <path d={markerPath(shape, 10, 6, 4)} fill={colour} stroke={SURFACE} strokeWidth={GAP} />
      </svg>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 h-3 w-3 shrink-0 rounded-[3px]"
      style={{ backgroundColor: colour }}
    />
  );
}

function Legend({ spec }: { spec: ChartSpec }) {
  const values = spec.series[0]?.values ?? [];
  const total = sumValues(values);
  // A pie's legend carries the figure and the share, because a slice's name is
  // no use to a candidate who then has to write about its size. When the values
  // are already percentages the share would only say the same thing twice.
  const entries =
    spec.kind === "pie"
      ? spec.categories.map((category, i) => {
          const value = values[i] ?? 0;
          const share = spec.unit === "%" ? "" : ` (${Math.round(percentOf(value, total))}%)`;
          return { label: `${category} — ${formatValue(value, spec.unit)}${share}` };
        })
      : spec.series.map((series) => ({ label: series.name }));

  // One series needs no legend: there is only one colour, and the title above
  // the chart has already said what is plotted.
  if (entries.length < 2) return null;

  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-600">
      {entries.map((entry, i) => (
        <li key={i} className="flex items-start gap-1.5">
          <LegendSwatch index={i} kind={spec.kind} />
          <span>{entry.label}</span>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ table ---

/**
 * The figures, marked up as a table.
 *
 * It is the text alternative for anyone who cannot see the picture, the place
 * a label that would not fit goes instead of being clipped, and — for a learner
 * who simply wants to check a number before writing about it — often the
 * quicker read. It is open to everyone rather than hidden behind `sr-only`.
 */
function FigureTable({ spec }: { spec: ChartSpec }) {
  const isPie = spec.kind === "pie";
  const values = spec.series[0]?.values ?? [];
  const total = sumValues(values);
  const shareColumn = isPie && spec.unit !== "%";
  const headers = isPie
    ? [spec.xLabel ?? "Category", spec.unit ? `Value (${spec.unit})` : "Value", ...(shareColumn ? ["Share"] : [])]
    : [spec.xLabel ?? "", ...spec.categories];

  const rows = isPie
    ? spec.categories.map((category, i) => [
        category,
        formatNumber(values[i] ?? 0),
        ...(shareColumn ? [`${Math.round(percentOf(values[i] ?? 0, total))}%`] : []),
      ])
    : spec.series.map((series) => [
        series.name,
        ...spec.categories.map((_, i) => {
          const value = series.values[i];
          return value === null || value === undefined ? "—" : formatNumber(value);
        }),
      ]);

  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">
        Show these figures as a table
      </summary>
      {/* Its own scroll container: a wide table must never widen the page. */}
      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="mb-2 text-left text-xs text-slate-500">
            {spec.title}
            {spec.unit && !isPie ? ` (${spec.unit})` : ""}
          </caption>
          <thead>
            <tr>
              {headers.map((header, i) => (
                <th
                  key={i}
                  scope="col"
                  className="border border-slate-300 bg-slate-100 px-3 py-2 text-left font-semibold whitespace-nowrap text-slate-700"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) =>
                  j === 0 ? (
                    <th
                      key={j}
                      scope="row"
                      className="border border-slate-300 px-3 py-2 text-left font-medium whitespace-nowrap text-slate-700"
                    >
                      {cell}
                    </th>
                  ) : (
                    <td
                      key={j}
                      className="border border-slate-300 px-3 py-2 text-slate-700"
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    >
                      {cell}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// ------------------------------------------------------------------- entry ---

export default function Chart({
  spec,
  className = "",
  plotHeight,
}: {
  spec: ChartSpec;
  className?: string;
  /**
   * The tallest the plot area may be drawn, in pixels.
   *
   * For a chart in a document — a Writing Task 1 figure — the default is
   * right: it is the thing on the page, and it should have room. A dashboard
   * is the other case, where a chart is one tile among several and its job is
   * to be glanced at, so the console asks for a shorter one and keeps the rest
   * of the screen.
   */
  plotHeight?: number;
}) {
  const [width, wrapper] = useMeasuredWidth();
  const id = useId();
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  const problems = chartProblems(spec);
  const drawn = Math.min(width, MAX_WIDTH);

  return (
    <figure className={`w-full min-w-0 ${className}`}>
      <figcaption className="mb-2 text-sm font-semibold text-slate-700">{spec.title}</figcaption>
      <div ref={wrapper} className="w-full min-w-0">
        <div className="mx-auto" style={{ maxWidth: drawn }}>
          {/*
            Never a half-drawn chart: say what is wrong and let the table below
            carry the task, so a broken spec costs a picture, not a question.
          */}
          {problems.length > 0 ? (
            <p className="rounded-lg border border-dashed border-slate-300 p-3 text-xs text-slate-500">
              This chart cannot be drawn ({problems.join("; ")}). The figures are in the table below.
            </p>
          ) : spec.kind === "pie" ? (
            <PiePlot spec={spec} width={drawn} titleId={titleId} descId={descId} />
          ) : (
            <CartesianPlot
              spec={spec}
              width={drawn}
              plotHeight={plotHeight}
              titleId={titleId}
              descId={descId}
            />
          )}
        </div>
      </div>
      <Legend spec={spec} />
      <FigureTable spec={spec} />
    </figure>
  );
}

function CartesianPlot({
  spec,
  width,
  plotHeight,
  titleId,
  descId,
}: {
  spec: Cartesian;
  width: number;
  plotHeight?: number;
  titleId: string;
  descId: string;
}) {
  const frame = buildFrame(spec, width, plotHeight);
  return (
    <svg
      role="img"
      aria-labelledby={`${titleId} ${descId}`}
      viewBox={`0 0 ${frame.width} ${frame.height}`}
      width={frame.width}
      height={frame.height}
      className="h-auto w-full"
    >
      <title id={titleId}>{spec.title}</title>
      <desc id={descId}>{chartSummary(spec)}</desc>
      <Grid frame={frame} spec={spec} />
      <CategoryLabels frame={frame} />
      {spec.kind === "line" ? (
        <LinePlot spec={spec} frame={frame} />
      ) : spec.layout === "stacked" ? (
        <StackedBars spec={spec} frame={frame} />
      ) : (
        <GroupedBars spec={spec} frame={frame} />
      )}
    </svg>
  );
}
