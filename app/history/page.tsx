"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useProfile } from "@/lib/hooks";
import { newestFirst, seriesFor } from "@/lib/results";
import type { ModuleName, ModuleResult } from "@/lib/types";

/*
  Every sitting the learner has recorded, and what the numbers are doing.

  One deliberate chart decision worth recording: this page draws four small
  single-series charts, not one four-series chart. The palette this app is
  built on is warm and analogous — clay, sage, honey — and four of its hues on
  one plot are indistinguishable under protanopia (ΔE 5.0, measured, a hard
  fail). Rather than bolt a foreign saturated palette onto a muted app, each
  module gets its own panel: identity comes from the panel's title, colour
  only ever decorates one series, and the archive table below carries the
  exact numbers for anyone the charts fail anyway.
*/

const MODULES: { key: ModuleName; label: string; stroke: string; text: string }[] = [
  { key: "listening", label: "Listening", stroke: "var(--color-emerald-600)", text: "text-emerald-600" },
  { key: "reading", label: "Reading", stroke: "var(--color-indigo-600)", text: "text-indigo-600" },
  { key: "writing", label: "Writing", stroke: "var(--color-amber-700)", text: "text-amber-700" },
  { key: "speaking", label: "Speaking", stroke: "var(--color-purple-700)", text: "text-purple-700" },
];

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString(undefined, { day: "numeric", month: "short" })
    : "";
}

/* One line, at most two clauses, and only claims the data can back. */
function insight(latest: Map<ModuleName, number>, target?: number): string | null {
  const entries = [...latest.entries()];
  if (entries.length < 2) return null;
  const best = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
  const worst = entries.reduce((a, b) => (b[1] < a[1] ? b : a));
  if (best[0] === worst[0]) return null;
  const name = (m: ModuleName) => m.charAt(0).toUpperCase() + m.slice(1);
  if (target !== undefined && worst[1] < target) {
    return `${name(best[0])} is your strongest at band ${best[1]}. ${name(worst[0])} is furthest from your band ${target} target — a band gained there moves your overall score most.`;
  }
  return `${name(best[0])} is your strongest at band ${best[1]}; ${name(worst[0])} is where a band is most easily gained.`;
}

/*
  The sparkline. SVG stretched to the tile with a fixed viewBox; the stroke
  keeps its true width via vector-effect, and the round things — end dot,
  hover dot — are HTML positioned by percentage, because circles inside a
  non-uniformly scaled SVG render as ellipses.
*/
const VB_W = 100;
const VB_H = 36;
const PAD_X = 4;
const PAD_TOP = 5;
const PAD_BOTTOM = 6;

interface Span {
  lo: number;
  hi: number;
}

function pxOf(i: number, n: number): number {
  return n <= 1 ? VB_W / 2 : PAD_X + ((VB_W - 2 * PAD_X) * i) / (n - 1);
}
function pyOf(band: number, span: Span): number {
  const usable = VB_H - PAD_TOP - PAD_BOTTOM;
  const t = (band - span.lo) / (span.hi - span.lo);
  return VB_H - PAD_BOTTOM - t * usable;
}

function Sparkline({
  series,
  span,
  stroke,
  label,
}: {
  series: ModuleResult[];
  span: Span;
  stroke: string;
  label: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const n = series.length;
  const points = series.map((r, i) => ({ x: pxOf(i, n), y: pyOf(r.band, span), r }));
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
  const area =
    n > 1 ? `${line} L${points[n - 1].x.toFixed(2)} ${VB_H} L${points[0].x.toFixed(2)} ${VB_H} Z` : "";
  const shown = hover ?? n - 1;
  const active = points[shown];

  function locate(e: React.PointerEvent<HTMLDivElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * VB_W;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(points[i].x - x) < Math.abs(points[best].x - x)) best = i;
    setHover(best);
  }

  return (
    <div
      className="relative mt-2 h-14 touch-none select-none"
      onPointerMove={n > 1 ? locate : undefined}
      onPointerLeave={() => setHover(null)}
    >
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        className="h-full w-full"
        role="img"
        aria-label={label}
      >
        {n > 1 && <path d={area} fill={stroke} fillOpacity="0.1" />}
        {n > 1 && (
          <path
            d={line}
            fill="none"
            stroke={stroke}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {/* The dot: latest sitting by default, the hovered one while pointing. */}
      <span
        aria-hidden="true"
        className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface"
        style={{
          left: `${active.x}%`,
          top: `${(active.y / VB_H) * 100}%`,
          backgroundColor: stroke,
        }}
      />
      {hover !== null && (
        <span
          className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-slate-200 bg-surface px-2 py-0.5 text-xs text-slate-700 shadow-sm"
          style={{ left: `${Math.min(82, Math.max(18, active.x))}%` }}
        >
          Band {active.r.band} · {fmtDate(active.r.date)}
        </span>
      )}
    </div>
  );
}

function StatTile({
  label,
  series,
  span,
  stroke,
  text,
}: {
  label: string;
  series: ModuleResult[];
  span: Span;
  stroke: string;
  text: string;
}) {
  const n = series.length;
  const latest = n > 0 ? series[n - 1].band : null;
  const prev = n > 1 ? series[n - 2].band : null;
  const delta = latest !== null && prev !== null ? Math.round((latest - prev) * 10) / 10 : null;

  return (
    <div className="card !p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className={`text-sm font-semibold ${text}`}>{label}</h3>
        <span className="text-xs text-slate-500">
          {n === 0 ? "" : n === 1 ? "1 sitting" : `${n} sittings`}
        </span>
      </div>
      {n === 0 ? (
        <p className="mt-3 text-sm leading-6 text-slate-500">
          Nothing yet — your first sitting will appear here.
        </p>
      ) : (
        <>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-semibold tracking-tight text-slate-900">{latest}</span>
            {delta !== null && (
              /* The sign travels with the number, not only with the colour. */
              <span
                className={`text-xs font-medium ${
                  delta > 0 ? "text-emerald-700" : delta < 0 ? "text-rose-700" : "text-slate-500"
                }`}
              >
                {delta > 0 ? `▲ ${delta}` : delta < 0 ? `▼ ${Math.abs(delta)}` : "— level"}
              </span>
            )}
          </div>
          <Sparkline
            series={series}
            span={span}
            stroke={stroke}
            label={`${label}: ${n} sittings, latest band ${latest}`}
          />
        </>
      )}
    </div>
  );
}

export default function HistoryPage() {
  const profile = useProfile();
  const results = useMemo(() => newestFirst(profile.results), [profile.results]);

  const byModule = useMemo(() => {
    const m = new Map<ModuleName, ModuleResult[]>();
    for (const mod of MODULES) m.set(mod.key, seriesFor(results, mod.key));
    return m;
  }, [results]);

  /*
    One vertical scale across all four panels, fitted to this learner's own
    range. A shared scale keeps the panels comparable; fitting it stops a
    5.5–7.0 learner's real movement rendering as a flat line on 0–9.
  */
  const span = useMemo<Span>(() => {
    const bands = results.map((r) => r.band);
    if (bands.length === 0) return { lo: 4, hi: 9 };
    const lo = Math.min(...bands);
    const hi = Math.max(...bands);
    return lo === hi ? { lo: lo - 0.75, hi: hi + 0.75 } : { lo: lo - 0.5, hi: hi + 0.5 };
  }, [results]);

  const latest = useMemo(() => {
    const m = new Map<ModuleName, number>();
    for (const [k, list] of byModule) if (list.length > 0) m.set(k, list[list.length - 1].band);
    return m;
  }, [byModule]);

  const line = insight(latest, profile.targetBand);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">History</h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-7 text-slate-600">
          {results.length === 0
            ? "Every practice test and its band will be recorded here."
            : `${results.length} recorded sitting${results.length === 1 ? "" : "s"}. Bands are practice estimates, and the trend matters more than any single one.`}
        </p>
        {line && <p className="mt-2 max-w-2xl text-[15px] leading-7 text-slate-700">{line}</p>}
      </header>

      {results.length === 0 ? (
        <div className="card">
          <p className="text-[15px] leading-7 text-slate-600">
            Sit any practice test and it lands here automatically —{" "}
            <Link href="/practice" className="font-medium text-indigo-700 underline underline-offset-2">
              start with a reading or listening test
            </Link>
            , or try the writing or speaking examiner.
          </p>
        </div>
      ) : (
        <>
          <section aria-label="Band by module" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {MODULES.map((m) => (
              <StatTile
                key={m.key}
                label={m.label}
                series={byModule.get(m.key) ?? []}
                span={span}
                stroke={m.stroke}
                text={m.text}
              />
            ))}
          </section>

          <section>
            <h2 className="heading-rule mb-4 text-base font-semibold text-slate-900">Every sitting</h2>
            {/* The table is the record — and the fallback for anyone the charts fail. */}
            <div className="max-h-[26rem] overflow-y-auto rounded-2xl border border-slate-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Date</th>
                    <th className="px-4 py-2.5 font-medium">Module</th>
                    <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Test</th>
                    <th className="px-4 py-2.5 text-right font-medium">Score</th>
                    <th className="px-4 py-2.5 text-right font-medium">Band</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-surface">
                  {results.map((r, i) => (
                    <tr key={`${r.testId}-${r.date}-${i}`}>
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">{fmtDate(r.date)}</td>
                      <td className="px-4 py-2.5 capitalize text-slate-800">{r.module}</td>
                      <td className="hidden max-w-[16rem] truncate px-4 py-2.5 text-slate-600 sm:table-cell">
                        {r.testTitle}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">
                        {r.raw !== undefined && r.total !== undefined ? `${r.raw}/${r.total}` : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-slate-900">
                        {r.band}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
