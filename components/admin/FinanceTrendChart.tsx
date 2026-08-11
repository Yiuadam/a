"use client";

import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";
import styles from "./FinanceTrendChart.module.css";

export interface FinancePoint {
  day: string;
  /** Major currency units: 4.90 means HK$4.90. */
  value: number;
}

export default function FinanceTrendChart({
  title,
  summary,
  label,
  points,
  currency,
  compact = false,
  tone = "revenue",
}: {
  title: string;
  summary: string;
  label: string;
  points: readonly FinancePoint[];
  currency: string;
  compact?: boolean;
  tone?: "revenue" | "positive" | "negative";
}) {
  const id = useId().replaceAll(":", "");
  const [active, setActive] = useState<number | null>(null);
  const width = 600;
  const height = compact ? 132 : 184;
  const left = 10;
  const right = 10;
  const top = 9;
  const bottom = 25;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const values = points.map((point) => finite(point.value));
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(0, ...values);
  const span = maximum === minimum ? Math.max(1, Math.abs(maximum)) : maximum - minimum;
  const floor = minimum - span * 0.08;
  const ceiling = maximum + span * 0.08;
  const range = ceiling - floor;
  const xAt = (index: number) =>
    points.length <= 1 ? width / 2 : left + (plotWidth * index) / (points.length - 1);
  const yAt = (value: number) => top + ((ceiling - value) / range) * plotHeight;
  const plotted = points.map((point, index) => ({ x: xAt(index), y: yAt(finite(point.value)) }));
  const line = smoothPath(plotted);
  const baseline = yAt(0);
  const area = plotted.length > 0
    ? `${line} L ${plotted.at(-1)?.x ?? left} ${baseline} L ${plotted[0]?.x ?? left} ${baseline} Z`
    : "";
  const selected = active != null && active < points.length ? active : null;
  const selectedPoint = selected == null ? null : points[selected] ?? null;
  const total = values.reduce((sum, value) => sum + value, 0);
  const formattedTotal = money(total, currency);
  const labels = labelIndices(points.length);

  const selectPointer = (event: PointerEvent<SVGSVGElement>) => {
    if (points.length === 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * width;
    const ratio = Math.min(1, Math.max(0, (x - left) / plotWidth));
    setActive(Math.round(ratio * (points.length - 1)));
  };

  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (points.length === 0) return;
    let next = selected ?? points.length - 1;
    if (event.key === "ArrowLeft") next = Math.max(0, next - 1);
    else if (event.key === "ArrowRight") next = Math.min(points.length - 1, next + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = points.length - 1;
    else if (event.key === "Escape") return setActive(null);
    else return;
    event.preventDefault();
    setActive(next);
  };

  return (
    <section
      className={`${styles.root} ${tone === "positive" ? styles.positive : tone === "negative" ? styles.negative : ""}`}
      aria-labelledby={`${id}-heading`}
    >
      <header className={styles.header}>
        <div className="min-w-0">
          <h2 id={`${id}-heading`} className={styles.title}>{title}</h2>
          <p className={styles.summary}>{summary}</p>
        </div>
        <span className={styles.legend}>{label}</span>
      </header>

      {points.length === 0 ? (
        <p className="grid min-h-32 place-items-center text-xs text-slate-400">No data yet</p>
      ) : (
        <svg
          className={styles.chart}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          tabIndex={0}
          aria-labelledby={`${id}-title ${id}-description ${id}-instructions`}
          onBlur={() => setActive(null)}
          onKeyDown={onKeyDown}
          onPointerDown={selectPointer}
          onPointerMove={selectPointer}
          onPointerLeave={(event) => event.pointerType === "mouse" && setActive(null)}
          onPointerCancel={() => setActive(null)}
        >
          <title id={`${id}-title`}>{title}</title>
          <desc id={`${id}-description`}>{summary}. Total {formattedTotal}.</desc>
          <defs>
            <linearGradient id={`${id}-fill`} x1="0" y1={top} x2="0" y2={top + plotHeight} gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="var(--finance-line)" stopOpacity="0.22" />
              <stop offset="1" stopColor="var(--finance-line)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {Array.from({ length: 4 }, (_, index) => {
            const y = top + (plotHeight * index) / 3;
            return <line key={index} x1={left} x2={width - right} y1={y} y2={y} stroke="var(--finance-grid)" strokeWidth="1" />;
          })}
          {minimum < 0 && maximum > 0 && (
            <line x1={left} x2={width - right} y1={baseline} y2={baseline} stroke="var(--finance-axis)" strokeWidth="1" />
          )}
          {area && <path d={area} fill={`url(#${id}-fill)`} />}
          <path d={line} fill="none" stroke="var(--finance-line)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          {plotted.at(-1) && <circle cx={plotted.at(-1)?.x} cy={plotted.at(-1)?.y} r="3.2" fill="var(--color-surface)" stroke="var(--finance-line)" strokeWidth="2.5" />}
          {labels.map((index, labelIndex) => (
            <text key={`${points[index]?.day}-${index}`} x={xAt(index)} y={height - 5} fill="var(--color-slate-400)" fontSize="10.5" textAnchor={labelIndex === 0 ? "start" : labelIndex === labels.length - 1 ? "end" : "middle"}>
              {dateLabel(points[index]?.day ?? "")}
            </text>
          ))}
          {selected != null && selectedPoint && (
            <Tooltip x={xAt(selected)} frameWidth={width} top={top} plotHeight={plotHeight} day={selectedPoint.day} value={selectedPoint.value} currency={currency} />
          )}
        </svg>
      )}
      <p id={`${id}-instructions`} className="sr-only">Focus the chart and use the left and right arrow keys to inspect each day.</p>
      <p className="sr-only" aria-live="polite">{selectedPoint ? `${dateLabel(selectedPoint.day)}: ${money(selectedPoint.value, currency)}` : ""}</p>

      {points.length > 0 && (
        <details className={styles.details}>
          <summary>View chart data</summary>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="sr-only">{title}: exact daily figures</caption>
              <thead><tr><th scope="col">Date</th><th scope="col">{label}</th></tr></thead>
              <tbody>{points.map((point) => <tr key={point.day}><td>{dateLabel(point.day)}</td><td>{money(point.value, currency)}</td></tr>)}</tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

function Tooltip({ x, frameWidth, top, plotHeight, day, value, currency }: { x: number; frameWidth: number; top: number; plotHeight: number; day: string; value: number; currency: string }) {
  const width = 150;
  const left = Math.max(10, Math.min(frameWidth - width - 10, x > frameWidth / 2 ? x - width - 8 : x + 8));
  return (
    <g aria-hidden="true" pointerEvents="none">
      <line x1={x} x2={x} y1={top} y2={top + plotHeight} stroke="var(--finance-axis)" strokeDasharray="3 4" />
      <rect x={left} y={top + 5} width={width} height="43" rx="9" fill="var(--color-surface)" stroke="var(--color-slate-300)" />
      <text x={left + 10} y={top + 21} fill="var(--color-slate-500)" fontSize="10.5">{dateLabel(day)}</text>
      <text x={left + 10} y={top + 38} fill="var(--finance-line)" fontSize="11.5" fontWeight="600">{money(value, currency)}</text>
    </g>
  );
}

function finite(value: number): number { return Number.isFinite(value) ? value : 0; }

function smoothPath(points: readonly { x: number; y: number }[]): string {
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

function labelIndices(count: number): number[] {
  if (count <= 0) return [];
  const wanted = Math.min(count, 6);
  if (wanted === 1) return [0];
  return Array.from(new Set(Array.from({ length: wanted }, (_, index) => Math.round((index * (count - 1)) / (wanted - 1)))));
}

function dateLabel(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!match) return day;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`));
}

export function money(value: number, currency: string): string {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: currency.toUpperCase(),
    maximumFractionDigits: 8,
  }).format(finite(value));
}
