/**
 * Chart data for Writing Task 1 — and the SVG maths the renderer runs on.
 *
 * Academic Task 1 mostly asks a candidate to describe a line graph, a bar chart
 * or a pie chart, but the only visual this app could show was a table, so those
 * prompts could not be set at all. The fix is a data shape rather than a
 * picture: authored as JSON a chart stays diffable, validatable and legible in
 * every theme, which an uploaded image would not be.
 *
 * The shape is deliberately the table's shape one step on. A `dataTable` is a
 * title, a header row and rows of cells; a `ChartSpec` is a title, a list of
 * `categories` (the header row minus its corner cell) and a list of `series`
 * (the rows, each with a name and one value per category). Anything already
 * written as a table can be re-authored as a chart by moving the labels.
 *
 * `kind` is the discriminant on purpose. Diagram labelling in Reading and map
 * labelling in Listening want the same data-in / SVG-out component, and they
 * arrive as new members of `ChartSpec` and one more branch in the renderer —
 * not as a second component and a second set of theme, layout and text
 * alternative rules to keep in step.
 */

// ---------------------------------------------------------------- the data ---

export type ChartKind = "line" | "bar" | "pie";

export interface ChartSeries {
  /** Legend label — a country, a sector, a year group. */
  name: string;
  /**
   * One value per entry in `categories`, in that order. `null` is a genuine
   * gap in the data ("no figure was collected that year") and is drawn as a
   * break in the line, never as a zero.
   */
  values: (number | null)[];
}

interface ChartSpecBase {
  /** Printed above the chart, exactly as `dataTable.title` is. */
  title: string;
  /** The x axis labels, or the slice labels for a pie. */
  categories: string[];
  series: ChartSeries[];
  /** What one value means — "%", "millions of cubic metres". */
  unit?: string;
  xLabel?: string;
  yLabel?: string;
  /**
   * Replaces the generated screen-reader description. Only worth writing when
   * the automatic one misses the point of the data; the figures themselves are
   * always available in the table beneath the chart.
   */
  description?: string;
}

export interface LineChartSpec extends ChartSpecBase {
  kind: "line";
  /** Pin the axis. Left alone it starts at zero and ends on a round number. */
  yMin?: number;
  yMax?: number;
}

export interface BarChartSpec extends ChartSpecBase {
  kind: "bar";
  /** Side by side (compare series) or stacked (compare composition). */
  layout?: "grouped" | "stacked";
  yMax?: number;
}

export interface PieChartSpec extends ChartSpecBase {
  kind: "pie";
  /**
   * `categories` are the slices and the single series holds their sizes. The
   * one-series rule is enforced by `chartProblems` rather than by the type,
   * because a spec arrives as JSON and has to be checked at runtime anyway.
   */
}

export type ChartSpec = LineChartSpec | BarChartSpec | PieChartSpec;

// --------------------------------------------------------------- the paint ---

/**
 * Series colours, in fixed order — slot 1 is always slot 1, so a chart that
 * loses a series does not repaint the ones that remain.
 *
 * Every entry is a theme variable rather than a literal, which is what makes a
 * chart follow Warm, Light and Dark like the rest of the app. The order was
 * chosen by running each theme's resolved hexes through a colour-vision check:
 * adjacent slots clear ΔE 11 under simulated protanopia and deuteranopia and
 * ΔE 15 under normal vision in all three themes, and every slot clears 3:1
 * against its theme's card surface.
 *
 * The one check the app's palette cannot pass is the chroma floor — the Warm
 * theme is muted by design, so its green, purple and neutral read closer to
 * grey than a chart palette would like. Colour is therefore never the only
 * channel here: the legend is always present, line series carry a distinct
 * marker shape, and every figure is repeated in the table below the chart.
 */
export const SERIES_COLORS = [
  "var(--color-indigo-600)",
  "var(--color-emerald-800)",
  "var(--color-purple-700)",
  "var(--color-amber-800)",
  "var(--color-rose-500)",
  "var(--color-slate-700)",
] as const;

export const MAX_SERIES = SERIES_COLORS.length;

export type MarkerShape = "circle" | "square" | "triangle" | "diamond" | "triangle-down" | "cross";

/** Paired with `SERIES_COLORS` by index — the backup channel when hue fails. */
export const SERIES_MARKERS: readonly MarkerShape[] = [
  "circle",
  "square",
  "triangle",
  "diamond",
  "triangle-down",
  "cross",
];

export const seriesColor = (i: number): string => SERIES_COLORS[i % SERIES_COLORS.length];
export const seriesMarker = (i: number): MarkerShape => SERIES_MARKERS[i % SERIES_MARKERS.length];

// -------------------------------------------------------------- validation ---

/**
 * Everything wrong with a spec, in plain English.
 *
 * A learner should never meet a half-drawn chart, so the renderer asks first
 * and falls back to the table when the answer is not empty. The same list is
 * what a content validator would print.
 */
export function chartProblems(spec: ChartSpec): string[] {
  const problems: string[] = [];
  if (spec.categories.length === 0) problems.push("no categories");
  if (spec.series.length === 0) problems.push("no series");
  if (spec.series.length > MAX_SERIES) {
    problems.push(
      `${spec.series.length} series, but only ${MAX_SERIES} can be told apart — ` +
        "combine the smallest into an “Other” series",
    );
  }
  for (const s of spec.series) {
    if (s.values.length !== spec.categories.length) {
      problems.push(
        `series “${s.name}” has ${s.values.length} values for ${spec.categories.length} categories`,
      );
    }
  }
  if (spec.kind === "pie") {
    if (spec.series.length > 1) problems.push("a pie chart takes one series");
    const values = spec.series[0]?.values ?? [];
    if (values.some((v) => v === null || v < 0)) problems.push("a pie chart needs a value ≥ 0 for every slice");
    if (sumValues(values) <= 0) problems.push("the slices add up to nothing");
  }
  if (spec.kind === "bar" && spec.layout === "stacked") {
    if (spec.series.some((s) => s.values.some((v) => v !== null && v < 0))) {
      problems.push("a stacked bar chart cannot show negative values");
    }
  }
  return problems;
}

// ------------------------------------------------------------------ scales ---

export interface Scale {
  min: number;
  max: number;
  ticks: number[];
}

/** Kills the 0.30000000000000004 that comes out of repeated addition. */
const clean = (v: number): number => Number(v.toPrecision(12));

function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalised = raw / magnitude;
  const multiple = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10;
  return multiple * magnitude;
}

/**
 * An axis whose ends are round numbers and whose ticks a learner can read off.
 * `target` is a wish, not a promise — the step is rounded to 1, 2, 2.5 or 5
 * times a power of ten first, so the count lands near it rather than on it.
 */
export function niceScale(dataMin: number, dataMax: number, target = 5): Scale {
  let lo = Math.min(dataMin, dataMax);
  let hi = Math.max(dataMin, dataMax);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (lo === hi) {
    // A flat series still needs an axis with height to it.
    if (lo === 0) hi = 1;
    else {
      const pad = Math.abs(lo) / 2;
      lo -= pad;
      hi += pad;
    }
  }
  const step = niceStep((hi - lo) / Math.max(1, target));
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step * 1e-9; v += step) ticks.push(clean(v));
  return { min: clean(min), max: clean(max), ticks };
}

/** Every value a chart plots, nulls dropped. */
export function chartValues(spec: ChartSpec): number[] {
  return spec.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
}

/** The per-category totals a stacked bar chart is scaled against. */
export function stackTotals(spec: ChartSpec): number[] {
  return spec.categories.map((_, i) => sumValues(spec.series.map((s) => s.values[i] ?? null)));
}

/** The value axis for a line or bar chart, zero-based unless told otherwise. */
export function valueScale(spec: LineChartSpec | BarChartSpec, target = 5): Scale {
  const values = spec.kind === "bar" && spec.layout === "stacked" ? stackTotals(spec) : chartValues(spec);
  const lo = spec.kind === "line" ? (spec.yMin ?? Math.min(0, ...values)) : Math.min(0, ...values);
  const hi = spec.yMax ?? Math.max(0, ...values);
  return niceScale(lo, hi, target);
}

// --------------------------------------------------------------- formatting ---

/**
 * Thousands-separated, and never more decimal places than the size of the
 * number warrants. Written out by hand rather than with `toLocaleString`,
 * because the server and the phone must agree to the character or React
 * reports a hydration mismatch.
 */
export function formatNumber(v: number): string {
  const magnitude = Math.abs(v);
  const places = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2;
  const fixed = Number(v.toFixed(places));
  const [whole, fraction] = Math.abs(fixed).toString().split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${fixed < 0 ? "−" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}

/** A value with its unit, tight for "%" and spaced for a word. */
export function formatValue(v: number, unit?: string): string {
  if (!unit) return formatNumber(v);
  return unit === "%" ? `${formatNumber(v)}%` : `${formatNumber(v)} ${unit}`;
}

export const percentOf = (v: number, whole: number): number => (whole > 0 ? (v / whole) * 100 : 0);

/** The sum of a series, treating a missing figure as nothing rather than zero. */
export const sumValues = (values: (number | null)[]): number =>
  values.reduce<number>((running, v) => running + (v ?? 0), 0);

// --------------------------------------------------- the text alternative ---

const KIND_NAMES: Record<ChartKind, string> = {
  line: "Line graph",
  bar: "Bar chart",
  pie: "Pie chart",
};

interface LabelledValue {
  value: number;
  category: string;
}

/** Where a series starts, where it ends, and its high and low along the way. */
function extremes(series: ChartSeries, categories: string[]) {
  const readings: LabelledValue[] = [];
  for (let i = 0; i < series.values.length; i++) {
    const v = series.values[i];
    if (v === null || v === undefined) continue;
    readings.push({ value: v, category: categories[i] ?? `point ${i + 1}` });
  }
  if (readings.length === 0) return null;
  let high = readings[0];
  let low = readings[0];
  for (const reading of readings) {
    if (reading.value > high.value) high = reading;
    if (reading.value < low.value) low = reading;
  }
  return { first: readings[0], last: readings[readings.length - 1], high, low };
}

/**
 * What a screen reader hears in place of the picture.
 *
 * It carries real figures, because "a bar chart" is not a description a
 * candidate can answer a Task 1 question from. Line series get their shape —
 * where they start, where they end, their high and their low — since a summary
 * is what the task actually asks for; bar and pie get every value, because
 * there are few enough of them to say. Either way the sentence ends by pointing
 * at the table, where every figure is marked up properly.
 */
export function chartSummary(spec: ChartSpec): string {
  if (spec.description) return spec.description;

  const parts: string[] = [`${KIND_NAMES[spec.kind]}. ${spec.title}.`];
  if (spec.unit) parts.push(`Figures are in ${spec.unit === "%" ? "per cent" : spec.unit}.`);

  if (spec.kind === "pie") {
    const values = spec.series[0]?.values ?? [];
    const total = sumValues(values);
    // Values that are already percentages do not need their share said twice.
    const slices = spec.categories
      .map((c, i) => {
        const v = values[i] ?? 0;
        const share = spec.unit === "%" ? "" : `, ${Math.round(percentOf(v, total))} per cent`;
        return `${c} ${formatValue(v, spec.unit)}${share}`;
      })
      .join("; ");
    parts.push(`${spec.categories.length} slices out of a total of ${formatValue(total, spec.unit)}: ${slices}.`);
  } else if (spec.kind === "line") {
    const axis = spec.categories.length
      ? `The horizontal axis runs from ${spec.categories[0]} to ${spec.categories[spec.categories.length - 1]}.`
      : "";
    if (axis) parts.push(axis);
    for (const s of spec.series) {
      const reading = extremes(s, spec.categories);
      if (!reading) {
        parts.push(`${s.name} has no figures.`);
        continue;
      }
      const { first, last, high, low } = reading;
      // A series that only rises has already had its high and low named by its
      // first and last readings; repeating them turns a summary into a drone.
      const turns = [
        high !== first && high !== last ? `a high of ${formatValue(high.value, spec.unit)} in ${high.category}` : "",
        low !== first && low !== last ? `a low of ${formatValue(low.value, spec.unit)} in ${low.category}` : "",
      ].filter(Boolean);
      parts.push(
        `${s.name} runs from ${formatValue(first.value, spec.unit)} in ${first.category} to ` +
          `${formatValue(last.value, spec.unit)} in ${last.category}` +
          `${turns.length ? `, with ${turns.join(" and ")}` : ""}.`,
      );
    }
  } else {
    const shape =
      spec.layout === "stacked"
        ? `${spec.categories.length} stacked bars, each split into ${spec.series.length} parts.`
        : `${spec.categories.length} groups of ${spec.series.length}.`;
    parts.push(shape);
    for (const s of spec.series) {
      // The unit has been stated once already, so the readings stay bare.
      const readings = spec.categories
        .map((c, i) => {
          const v = s.values[i];
          return `${c} ${v === null || v === undefined ? "no figure" : formatNumber(v)}`;
        })
        .join(", ");
      parts.push(`${s.name}: ${readings}.`);
    }
    if (spec.layout === "stacked") {
      const totals = stackTotals(spec)
        .map((t, i) => `${spec.categories[i]} ${formatNumber(t)}`)
        .join(", ");
      parts.push(`Totals: ${totals}.`);
    }
  }

  parts.push("The same figures are set out in the table below the chart.");
  return parts.join(" ");
}

// ------------------------------------------------------------- SVG geometry ---

/**
 * Where a point sits on a circle, measured clockwise from twelve o'clock —
 * the direction a pie chart is read in, and the one a map or diagram callout
 * will want too.
 */
export function polarPoint(cx: number, cy: number, r: number, angle: number): { x: number; y: number } {
  const radians = ((angle - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(radians), y: cy + r * Math.sin(radians) };
}

/** A pie wedge from `start` to `end` degrees. A full turn becomes a circle. */
export function wedgePath(cx: number, cy: number, r: number, start: number, end: number): string {
  const sweep = end - start;
  if (sweep >= 359.999) {
    // `A` cannot draw a full turn: the two ends coincide and nothing is drawn.
    return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.001} ${cy - r} Z`;
  }
  const from = polarPoint(cx, cy, r, start);
  const to = polarPoint(cx, cy, r, end);
  const largeArc = sweep > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${round(from.x)} ${round(from.y)} A ${r} ${r} 0 ${largeArc} 1 ${round(to.x)} ${round(to.y)} Z`;
}

const round = (v: number): number => Math.round(v * 100) / 100;

/**
 * A bar with its data end rounded and its baseline end square, so the eye
 * reads which end is the measurement. `y0` is the baseline, `y1` the value —
 * pass them either way round and a negative bar rounds its bottom instead.
 */
export function barPath(x: number, y0: number, y1: number, w: number, radius = 4): string {
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  const h = bottom - top;
  const r = Math.max(0, Math.min(radius, w / 2, h));
  const right = x + w;
  return y1 <= y0
    ? `M ${round(x)} ${round(bottom)} L ${round(x)} ${round(top + r)} Q ${round(x)} ${round(top)} ${round(x + r)} ${round(top)} ` +
        `L ${round(right - r)} ${round(top)} Q ${round(right)} ${round(top)} ${round(right)} ${round(top + r)} ` +
        `L ${round(right)} ${round(bottom)} Z`
    : `M ${round(x)} ${round(top)} L ${round(x)} ${round(bottom - r)} Q ${round(x)} ${round(bottom)} ${round(x + r)} ${round(bottom)} ` +
        `L ${round(right - r)} ${round(bottom)} Q ${round(right)} ${round(bottom)} ${round(right)} ${round(bottom - r)} ` +
        `L ${round(right)} ${round(top)} Z`;
}

/** A series marker, as one path so every shape draws through the same code. */
export function markerPath(shape: MarkerShape, x: number, y: number, r: number): string {
  switch (shape) {
    case "square":
      return `M ${round(x - r)} ${round(y - r)} H ${round(x + r)} V ${round(y + r)} H ${round(x - r)} Z`;
    case "triangle":
      return `M ${round(x)} ${round(y - r * 1.15)} L ${round(x + r * 1.1)} ${round(y + r * 0.85)} L ${round(x - r * 1.1)} ${round(y + r * 0.85)} Z`;
    case "triangle-down":
      return `M ${round(x)} ${round(y + r * 1.15)} L ${round(x + r * 1.1)} ${round(y - r * 0.85)} L ${round(x - r * 1.1)} ${round(y - r * 0.85)} Z`;
    case "diamond":
      return `M ${round(x)} ${round(y - r * 1.25)} L ${round(x + r * 1.25)} ${round(y)} L ${round(x)} ${round(y + r * 1.25)} L ${round(x - r * 1.25)} ${round(y)} Z`;
    case "cross": {
      const a = r * 0.42;
      const b = r * 1.2;
      return (
        `M ${round(x - a)} ${round(y - b)} H ${round(x + a)} V ${round(y - a)} H ${round(x + b)} ` +
        `V ${round(y + a)} H ${round(x + a)} V ${round(y + b)} H ${round(x - a)} V ${round(y + a)} ` +
        `H ${round(x - b)} V ${round(y - a)} H ${round(x - a)} Z`
      );
    }
    default:
      // Two half-arcs, because <circle> is not a path and this keeps one API.
      return `M ${round(x - r)} ${round(y)} A ${r} ${r} 0 1 0 ${round(x + r)} ${round(y)} A ${r} ${r} 0 1 0 ${round(x - r)} ${round(y)} Z`;
  }
}

// ---------------------------------------------------- shapes, not pixels yet ---

/*
  The three functions below turn a spec into the shapes a chart is made of,
  still measured in the data's own units. The renderer then maps those onto the
  plot with its own scale. Keeping the step separate is what lets the maths be
  read, reasoned about and reused — the labelled diagrams and maps this
  component is meant to grow into will want their own shape functions and the
  same JSX around them.
*/

export interface Reading {
  index: number;
  value: number;
}

/**
 * A line broken into the runs it can actually be drawn as. A `null` is a gap in
 * the record, so the line stops and restarts rather than diving to the axis and
 * inventing a reading that was never taken.
 */
export function lineRuns(values: (number | null)[]): Reading[][] {
  const runs: Reading[][] = [];
  let run: Reading[] = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === null || value === undefined) {
      if (run.length) runs.push(run);
      run = [];
      continue;
    }
    run.push({ index, value });
  }
  if (run.length) runs.push(run);
  return runs;
}

/** The last reading in a series, for the label that rides the end of a line. */
export function lastReading(values: (number | null)[]): Reading | null {
  for (let index = values.length - 1; index >= 0; index--) {
    const value = values[index];
    if (value !== null && value !== undefined) return { index, value };
  }
  return null;
}

export interface StackSegment {
  seriesIndex: number;
  /** Where the segment starts and ends up the stack, in the data's units. */
  from: number;
  to: number;
  isTop: boolean;
}

/** One category's stack, bottom to top, zero and missing figures dropped. */
export function stackSegments(spec: BarChartSpec, categoryIndex: number): StackSegment[] {
  const segments: StackSegment[] = [];
  let cumulative = 0;
  spec.series.forEach((series, seriesIndex) => {
    const value = series.values[categoryIndex];
    if (value === null || value === undefined || value <= 0) return;
    segments.push({ seriesIndex, from: cumulative, to: cumulative + value, isTop: false });
    cumulative += value;
  });
  if (segments.length) segments[segments.length - 1].isTop = true;
  return segments;
}

export interface PieSlice {
  category: string;
  value: number;
  /** Per cent of the whole. */
  share: number;
  /** Degrees clockwise from twelve o'clock. */
  start: number;
  end: number;
  mid: number;
}

export function pieSlices(spec: ChartSpec): PieSlice[] {
  const values = spec.series[0]?.values ?? [];
  const whole = sumValues(values);
  const slices: PieSlice[] = [];
  let angle = 0;
  for (let i = 0; i < spec.categories.length; i++) {
    const value = values[i] ?? 0;
    const sweep = whole > 0 ? (value / whole) * 360 : 0;
    slices.push({
      category: spec.categories[i],
      value,
      share: percentOf(value, whole),
      start: angle,
      end: angle + sweep,
      mid: angle + sweep / 2,
    });
    angle += sweep;
  }
  return slices;
}

export interface PieLabel {
  category: string;
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  text: string;
}

/**
 * The percentages that ride just outside the arc.
 *
 * A slice too thin to label, or one whose label would land on the label above
 * it, simply does not get one. Nothing is lost by that — the legend names every
 * slice with its figure and its share, and the table repeats them — and it is
 * the only honest answer, since nudging labels apart detaches them from their
 * slices and clipping them is worse than leaving them off.
 */
export function pieLabels(
  slices: PieSlice[],
  cx: number,
  cy: number,
  radius: number,
  fontSize: number,
): PieLabel[] {
  const labels: PieLabel[] = [];
  const lastY: { left: number | null; right: number | null } = { left: null, right: null };
  for (const slice of slices) {
    if (slice.share < 6) continue;
    const point = polarPoint(cx, cy, radius + 10, slice.mid);
    const side = slice.mid < 180 ? "right" : "left";
    const previous = lastY[side];
    if (previous !== null && Math.abs(point.y - previous) < fontSize * 1.2) continue;
    lastY[side] = point.y;
    const upright = slice.mid < 12 || Math.abs(slice.mid - 180) < 12 || slice.mid > 348;
    labels.push({
      category: slice.category,
      x: point.x,
      y: point.y + fontSize * 0.35,
      anchor: upright ? "middle" : side === "right" ? "start" : "end",
      text: `${Math.round(slice.share)}%`,
    });
  }
  return labels;
}

/**
 * Roughly how wide a string will be at a given font size.
 *
 * Nothing measures text before it is drawn, and an SVG has no reflow to save a
 * bad guess — so the renderer estimates, and the estimate is deliberately a
 * little generous. Being 5% too wide costs a few pixels of margin; being too
 * narrow puts a label through the edge of the chart.
 */
export const textWidth = (text: string, fontSize: number): number => text.length * fontSize * 0.58;
