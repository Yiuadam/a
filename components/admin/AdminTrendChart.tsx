"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import type { DayRow } from "@/lib/admin/useConsole";
import styles from "./AdminTrendChart.module.css";

type TrendKind = "signups" | "usage";

export interface AdminTrendChartProps {
  kind: TrendKind;
  rows: readonly DayRow[];
  days?: number;
  /** A shorter plot for the all-in-one overview. */
  compact?: boolean;
  className?: string;
}

interface Point {
  x: number;
  y: number;
}

interface Frame {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  plotWidth: number;
  plotHeight: number;
  xAt: (index: number) => number;
  yAt: (value: number) => number;
}

const FALLBACK_WIDTH = 560;
const MIN_WIDTH = 220;
const MAX_WIDTH = 920;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function useMeasuredWidth(): [number, RefObject<HTMLDivElement | null>] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const update = (measured: number) => {
      if (measured <= 0) return;
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(measured))));
    };
    update(element.getBoundingClientRect().width);

    const observer = new ResizeObserver((entries) => {
      update(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [width, ref];
}

function valueOf(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

function roundedMaximum(maximum: number): number {
  if (maximum <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(maximum));
  const step = magnitude >= 10 ? magnitude / 2 : 1;
  return Math.ceil(maximum / step) * step;
}

function buildFrame(
  width: number,
  height: number,
  count: number,
  maximum: number,
  kind: TrendKind,
): Frame {
  const left = 8;
  const right = 8;
  const top = 8;
  const bottom = 25;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const safeCount = Math.max(1, count);
  const ceiling = roundedMaximum(maximum);

  return {
    width,
    height,
    left,
    right,
    top,
    plotWidth,
    plotHeight,
    xAt: (index) =>
      kind === "usage"
        ? left + (plotWidth * (index + 0.5)) / safeCount
        : safeCount === 1
          ? left + plotWidth / 2
          : left + (plotWidth * index) / (safeCount - 1),
    yAt: (value) => top + plotHeight - (value / ceiling) * plotHeight,
  };
}

/** A restrained curve: smooth between readings without overshooting their values. */
function smoothPath(points: readonly Point[]): string {
  if (points.length === 0) return "";
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const middle = (previous.x + current.x) / 2;
    path += ` C ${middle} ${previous.y}, ${middle} ${current.y}, ${current.x} ${current.y}`;
  }
  return path;
}

function roundedTopPath(x: number, y: number, width: number, height: number): string {
  if (height <= 0 || width <= 0) return "";
  const radius = Math.min(4, width / 2, height);
  return [
    `M ${x} ${y + height}`,
    `L ${x} ${y + radius}`,
    `Q ${x} ${y} ${x + radius} ${y}`,
    `L ${x + width - radius} ${y}`,
    `Q ${x + width} ${y} ${x + width} ${y + radius}`,
    `L ${x + width} ${y + height}`,
    "Z",
  ].join(" ");
}

function dateLabel(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!match) return day.length > 9 ? `${day.slice(0, 8)}…` : day;
  const month = MONTHS[Number(match[2]) - 1] ?? match[2];
  return `${month} ${Number(match[3])}`;
}

function dateLabelIndices(count: number, width: number): number[] {
  if (count <= 0) return [];
  const wanted = Math.min(count, width < 440 ? 5 : 6);
  if (wanted === 1) return [0];
  return Array.from(
    new Set(
      Array.from({ length: wanted }, (_, index) =>
        Math.round((index * (count - 1)) / (wanted - 1)),
      ),
    ),
  );
}

function plural(value: number, one: string, many = `${one}s`): string {
  return `${value.toLocaleString()} ${value === 1 ? one : many}`;
}

function rowText(kind: TrendKind, row: DayRow): string {
  if (kind === "signups") return `${dateLabel(row.day)}: ${plural(valueOf(row.count), "signup")}`;
  return `${dateLabel(row.day)}: ${plural(valueOf(row.admitted), "served request")}, ${plural(
    valueOf(row.denied),
    "refused request",
  )}`;
}

export default function AdminTrendChart({
  kind,
  rows,
  days = rows.length,
  compact = false,
  className,
}: AdminTrendChartProps) {
  const [width, frameRef] = useMeasuredWidth();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const id = useId().replaceAll(":", "");
  const height = compact ? 132 : 176;
  const values = rows.map((row) =>
    kind === "signups" ? valueOf(row.count) : valueOf(row.admitted) + valueOf(row.denied),
  );
  const maximum = Math.max(0, ...values);
  const frame = buildFrame(width, height, rows.length, maximum, kind);
  const labels = dateLabelIndices(rows.length, width);
  const totalSignups = rows.reduce((total, row) => total + valueOf(row.count), 0);
  const totalServed = rows.reduce((total, row) => total + valueOf(row.admitted), 0);
  const totalRefused = rows.reduce((total, row) => total + valueOf(row.denied), 0);
  const title = kind === "signups" ? "New accounts" : "AI requests";
  const summary =
    kind === "signups"
      ? `${plural(totalSignups, "signup")} · ${days} days`
      : `${totalServed.toLocaleString()} served · ${totalRefused.toLocaleString()} refused`;
  const description =
    kind === "signups"
      ? `Daily new accounts over the last ${days} days. ${plural(totalSignups, "signup")} in total.`
      : `Daily AI requests over the last ${days} days. ${plural(totalServed, "request")} served and ${plural(totalRefused, "request")} refused.`;
  /* Data can refresh while the owner is inspecting it. Treat an old index as
     no selection without scheduling a second render just to clear the state. */
  const selectedIndex = activeIndex != null && activeIndex < rows.length ? activeIndex : null;
  const activeRow = selectedIndex == null ? null : rows[selectedIndex] ?? null;

  const selectFromPointer = (event: PointerEvent<SVGSVGElement>) => {
    if (rows.length === 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const svgX = ((event.clientX - bounds.left) / bounds.width) * frame.width;
    const ratio = Math.min(1, Math.max(0, (svgX - frame.left) / frame.plotWidth));
    setActiveIndex(
      kind === "usage"
        ? Math.min(rows.length - 1, Math.floor(ratio * rows.length))
        : Math.round(ratio * (rows.length - 1)),
    );
  };

  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (rows.length === 0) return;
    let next = selectedIndex ?? rows.length - 1;
    if (event.key === "ArrowLeft") next = Math.max(0, next - 1);
    else if (event.key === "ArrowRight") next = Math.min(rows.length - 1, next + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    else if (event.key === "Escape") {
      setActiveIndex(null);
      return;
    } else return;
    event.preventDefault();
    setActiveIndex(next);
  };

  return (
    <section
      className={`${styles.root}${className ? ` ${className}` : ""}`}
      aria-labelledby={`${id}-heading`}
    >
      <header className={styles.header}>
        <div className={styles.heading}>
          <h2 id={`${id}-heading`} className={styles.title}>
            {title}
          </h2>
          <p className={styles.summary}>{summary}</p>
        </div>
        <div className={styles.legend} aria-label="Chart legend">
          <span className={styles.legendItem}>
            <span className={styles.legendMark} aria-hidden="true" />
            {kind === "signups" ? "Signups" : "Served"}
          </span>
          {kind === "usage" && (
            <span className={styles.legendItem}>
              <span
                className={`${styles.legendMark} ${styles.legendMarkRefused}`}
                aria-hidden="true"
              />
              Refused
            </span>
          )}
        </div>
      </header>

      <div ref={frameRef} className={styles.chartFrame}>
        {rows.length === 0 ? (
          <p className={styles.empty}>No data yet</p>
        ) : (
          <svg
            className={styles.chart}
            viewBox={`0 0 ${frame.width} ${frame.height}`}
            width="100%"
            height={frame.height}
            role="img"
            tabIndex={0}
            aria-labelledby={`${id}-svg-title ${id}-svg-description ${id}-instructions`}
            aria-keyshortcuts="ArrowLeft ArrowRight Home End Escape"
            onBlur={() => setActiveIndex(null)}
            onKeyDown={onKeyDown}
            onPointerDown={selectFromPointer}
            onPointerMove={selectFromPointer}
            onPointerLeave={(event) => {
              if (event.pointerType === "mouse") setActiveIndex(null);
            }}
            onPointerCancel={() => setActiveIndex(null)}
          >
            <title id={`${id}-svg-title`}>{title}</title>
            <desc id={`${id}-svg-description`}>{description}</desc>
            <defs>
              <linearGradient
                id={`${id}-area`}
                x1="0"
                y1={frame.top}
                x2="0"
                y2={frame.top + frame.plotHeight}
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stopColor="var(--admin-chart-primary)" stopOpacity="0.24" />
                <stop offset="1" stopColor="var(--admin-chart-primary)" stopOpacity="0" />
              </linearGradient>
            </defs>

            <Grid frame={frame} />
            {kind === "signups" ? (
              <SignupPlot
                rows={rows}
                frame={frame}
                gradientId={`${id}-area`}
                activeIndex={selectedIndex}
              />
            ) : (
              <UsagePlot rows={rows} frame={frame} activeIndex={selectedIndex} />
            )}
            <DateLabels rows={rows} indices={labels} frame={frame} />
            {selectedIndex != null && activeRow && (
              <Selection kind={kind} row={activeRow} index={selectedIndex} frame={frame} />
            )}
          </svg>
        )}
        <p id={`${id}-instructions`} className="sr-only">
          Focus the chart and use the left and right arrow keys to inspect each day. Press Home
          or End to jump to the first or last day. Press Escape to clear the selection.
        </p>
        <p className="sr-only" aria-live="polite">
          {activeRow ? rowText(kind, activeRow) : ""}
        </p>
      </div>

      {rows.length > 0 && (
        <details className={styles.details}>
          <summary>View chart data</summary>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="sr-only">{description}</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  {kind === "signups" ? (
                    <th scope="col" className={styles.numeric}>
                      Signups
                    </th>
                  ) : (
                    <>
                      <th scope="col" className={styles.numeric}>
                        Served
                      </th>
                      <th scope="col" className={styles.numeric}>
                        Refused
                      </th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`${row.day}-${index}`}>
                    <td>{dateLabel(row.day)}</td>
                    {kind === "signups" ? (
                      <td className={styles.numeric}>{valueOf(row.count).toLocaleString()}</td>
                    ) : (
                      <>
                        <td className={styles.numeric}>{valueOf(row.admitted).toLocaleString()}</td>
                        <td className={styles.numeric}>{valueOf(row.denied).toLocaleString()}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

function Grid({ frame }: { frame: Frame }) {
  return (
    <g aria-hidden="true">
      {Array.from({ length: 4 }, (_, index) => {
        const y = frame.top + (frame.plotHeight * index) / 3;
        return (
          <line
            key={index}
            x1={frame.left}
            x2={frame.width - frame.right}
            y1={y}
            y2={y}
            stroke={index === 3 ? "var(--admin-chart-axis)" : "var(--admin-chart-grid)"}
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </g>
  );
}

function SignupPlot({
  rows,
  frame,
  gradientId,
  activeIndex,
}: {
  rows: readonly DayRow[];
  frame: Frame;
  gradientId: string;
  activeIndex: number | null;
}) {
  const points = rows.map((row, index) => ({ x: frame.xAt(index), y: frame.yAt(valueOf(row.count)) }));
  const line = smoothPath(points);
  const first = points[0];
  const last = points.at(-1);
  const area = first && last ? `${line} L ${last.x} ${frame.top + frame.plotHeight} L ${first.x} ${frame.top + frame.plotHeight} Z` : "";

  return (
    <g aria-hidden="true">
      {area && <path d={area} fill={`url(#${gradientId})`} />}
      {line && (
        <path
          d={line}
          fill="none"
          stroke="var(--admin-chart-primary)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {last && (
        <circle
          cx={last.x}
          cy={last.y}
          r="3.2"
          fill="var(--color-surface)"
          stroke="var(--admin-chart-primary)"
          strokeWidth="2.5"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {activeIndex != null && activeIndex !== rows.length - 1 && points[activeIndex] && (
        <circle
          cx={points[activeIndex].x}
          cy={points[activeIndex].y}
          r="3"
          fill="var(--color-surface)"
          stroke="var(--admin-chart-primary)"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </g>
  );
}

function UsagePlot({ rows, frame, activeIndex }: { rows: readonly DayRow[]; frame: Frame; activeIndex: number | null }) {
  const slot = frame.plotWidth / Math.max(1, rows.length);
  const gap = Math.min(5, Math.max(2, slot * 0.34));
  const barWidth = Math.max(2, slot - gap);
  const baseline = frame.top + frame.plotHeight;

  return (
    <g aria-hidden="true">
      {rows.map((row, index) => {
        const served = valueOf(row.admitted);
        const refused = valueOf(row.denied);
        const servedHeight = baseline - frame.yAt(served);
        const totalHeight = baseline - frame.yAt(served + refused);
        const refusedHeight = Math.max(0, totalHeight - servedHeight);
        const x = frame.left + slot * index + (slot - barWidth) / 2;
        const servedY = baseline - servedHeight;
        const refusedY = servedY - refusedHeight;
        const servedIsTop = refusedHeight === 0;

        return (
          <g key={`${row.day}-${index}`} opacity={activeIndex == null || activeIndex === index ? 1 : 0.56}>
            {servedHeight > 0 &&
              (servedIsTop ? (
                <path d={roundedTopPath(x, servedY, barWidth, servedHeight)} fill="var(--admin-chart-primary)" />
              ) : (
                <rect x={x} y={servedY} width={barWidth} height={servedHeight} fill="var(--admin-chart-primary)" />
              ))}
            {refusedHeight > 0 && (
              <path d={roundedTopPath(x, refusedY, barWidth, refusedHeight)} fill="var(--admin-chart-refused)" />
            )}
          </g>
        );
      })}
    </g>
  );
}

function DateLabels({ rows, indices, frame }: { rows: readonly DayRow[]; indices: readonly number[]; frame: Frame }) {
  return (
    <g aria-hidden="true" fill="var(--color-slate-400)" fontSize="10.5">
      {indices.map((index, labelIndex) => (
        <text
          key={`${rows[index]?.day}-${index}`}
          x={frame.xAt(index)}
          y={frame.height - 5}
          textAnchor={labelIndex === 0 ? "start" : labelIndex === indices.length - 1 ? "end" : "middle"}
        >
          {dateLabel(rows[index]?.day ?? "")}
        </text>
      ))}
    </g>
  );
}

function Selection({ kind, row, index, frame }: { kind: TrendKind; row: DayRow; index: number; frame: Frame }) {
  const x = frame.xAt(index);
  const tooltipWidth = kind === "signups" ? 132 : 158;
  const tooltipHeight = kind === "signups" ? 42 : 55;
  const preferredX = x > frame.width / 2 ? x - tooltipWidth - 7 : x + 7;
  const tooltipX = Math.max(frame.left, Math.min(frame.width - frame.right - tooltipWidth, preferredX));
  const tooltipY = frame.top + 5;

  return (
    <g aria-hidden="true" pointerEvents="none">
      <line
        x1={x}
        x2={x}
        y1={frame.top}
        y2={frame.top + frame.plotHeight}
        stroke="var(--admin-chart-crosshair)"
        strokeWidth="1"
        strokeDasharray="3 4"
        vectorEffect="non-scaling-stroke"
      />
      <rect
        x={tooltipX}
        y={tooltipY}
        width={tooltipWidth}
        height={tooltipHeight}
        rx="9"
        fill="var(--color-surface)"
        stroke="var(--color-slate-300)"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
      <text x={tooltipX + 10} y={tooltipY + 16} fill="var(--color-slate-500)" fontSize="10.5">
        {dateLabel(row.day)}
      </text>
      {kind === "signups" ? (
        <text x={tooltipX + 10} y={tooltipY + 32} fill="var(--color-slate-900)" fontSize="11.5" fontWeight="600">
          {plural(valueOf(row.count), "signup")}
        </text>
      ) : (
        <>
          <text x={tooltipX + 10} y={tooltipY + 32} fill="var(--admin-chart-primary)" fontSize="11.5" fontWeight="600">
            {valueOf(row.admitted).toLocaleString()} served
          </text>
          <text x={tooltipX + 10} y={tooltipY + 47} fill="var(--admin-chart-refused)" fontSize="11.5" fontWeight="600">
            {valueOf(row.denied).toLocaleString()} refused
          </text>
        </>
      )}
    </g>
  );
}
