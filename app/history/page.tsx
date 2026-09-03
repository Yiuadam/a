"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import BandBadge from "@/components/BandBadge";
import ClearHistoryButton from "@/components/history/ClearHistoryButton";
import LookupHistoryCard from "@/components/history/LookupHistoryCard";
import { retakesOf, standingRecord, type StandingModule, type StandingRecord } from "@/lib/exam/report";
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
  {
    key: "reading",
    label: "Reading",
    stroke: "var(--chart-reading)",
    text: "text-[color:var(--chart-reading)]",
  },
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
      className="relative mt-1.5 h-11 touch-none select-none"
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
    <div className="card !p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className={`text-sm font-semibold ${text}`}>{label}</h3>
        <span className="text-xs text-slate-500">
          {n === 0 ? "" : n === 1 ? "1 sitting" : `${n} sittings`}
        </span>
      </div>
      {n === 0 ? (
        <p className="mt-1.5 text-xs leading-5 text-slate-500">
          Nothing yet — your first sitting appears here.
        </p>
      ) : (
        <>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="text-xl font-semibold tracking-tight text-slate-900">{latest}</span>
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

const MODULE_LABEL: Record<ModuleName, string> = MODULES.reduce(
  (labels, module) => ({ ...labels, [module.key]: module.label }),
  {} as Record<ModuleName, string>,
);

/*
  The standing Test Report Form: the learner's most recent full sitting, with
  any skill they have since re-sat replacing that skill's band.

  ---------------------------------------------------------------------------
  Why the overall lives here and not over the four tiles below

  The tiles plot every practice paper a learner has ever done, one series per
  skill, and it is tempting to average the four latest points into an "overall
  band" and print it at the top of the page. It would be wrong in the way this
  app has already decided not to be wrong elsewhere: those four numbers come
  from four different days, four different papers and four different amounts of
  interruption, and their mean is not a band anybody scored. An overall band
  describes one measurement of one candidate on one occasion.

  So the overall is anchored to a sitting, and a retake is what keeps it
  current — which is exactly the arrangement IELTS itself uses. A learner who
  has never sat a full mock is told so and pointed at one, rather than shown a
  number that would not survive being asked where it came from.

  A skill with no band at all is not a reason to hide the card; it is the
  reason the card says which skill is missing and offers to sit it. Filling the
  last gap is the one way an overall can appear for the first time without a
  second three-hour sitting.
*/
function StandingCard({ record }: { record: StandingRecord }) {
  const updated = record.issuedAt !== record.satAt;

  return (
    <section className="card space-y-3" aria-label="Your standing band">
      {/*
        The heading above the row rather than beside the badge. Stacked on a
        phone, a heading inside the second column renders *below* the number it
        names, which reads as a caption and is announced as one.
      */}
      <h2 className="text-base font-semibold text-slate-900">Your IELTS band</h2>
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:gap-6">
        {record.overall !== null ? (
          /* No `caption` override: BandBadge already prints bandLabel as its
             own first line, so passing it again printed "Good user" twice. The
             default caption is the CEFR estimate, which says something new. */
          <BandBadge band={record.overall} />
        ) : (
          <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-slate-300 text-center text-xs leading-4 text-slate-400">
            no overall band
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-1.5 text-center sm:text-left">
          {record.overall !== null ? (
            <p className="text-sm leading-6 text-slate-600">
              The mean of the four skills below, rounded to the nearest half band — the official
              rule. Re-sit any one skill and this recalculates from the new band and the other
              three, the way an IELTS One Skill Retake does.
            </p>
          ) : (
            <p className="text-sm leading-6 text-slate-600">
              {record.unmarked.map((m) => MODULE_LABEL[m]).join(" and ")}{" "}
              {record.unmarked.length > 1 ? "have" : "has"} never been marked, so there is no
              overall band. An overall is the mean of four, and averaging the three that exist
              would give you a number that looks like an IELTS score and is not one. Sit the
              missing {record.unmarked.length > 1 ? "skills" : "skill"} below and it appears.
            </p>
          )}
          {/* "Sat 12 Aug" was the first wording, and it reads as a weekday. */}
          <p className="text-xs text-slate-500">
            Sitting of {fmtDate(record.satAt)}
            {updated ? ` · updated ${fmtDate(record.issuedAt)}` : null}
          </p>
        </div>
      </div>

      <ul className="grid gap-2 sm:grid-cols-2">
        {record.modules.map((entry) => (
          <StandingRow key={entry.module} entry={entry} reportId={record.reportId} />
        ))}
      </ul>
    </section>
  );
}

function StandingRow({ entry, reportId }: { entry: StandingModule; reportId: string }) {
  const moved =
    entry.original !== null && entry.band !== null
      ? Math.round((entry.band - entry.original) * 10) / 10
      : null;

  return (
    <li className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2">
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-800">
          {MODULE_LABEL[entry.module]}
        </span>
        {/*
          The original band stays on the row whenever a retake has replaced it,
          in both directions. A record that showed only improvements would be a
          trophy cabinet rather than a history, and the learner deciding whether
          to book the real test is the person least well served by one.
        */}
        <span className="block truncate text-xs text-slate-500">
          {entry.retakes === 0
            ? entry.band === null
              ? "Not marked in your sitting"
              : "From your sitting"
            : entry.original === null
              ? `Retake · not sat in the exam${entry.retakes > 1 ? ` · ${entry.retakes} retakes` : ""}`
              : `Retake · was ${entry.original}${moved !== null && moved !== 0 ? (moved > 0 ? ` (▲ ${moved})` : ` (▼ ${Math.abs(moved)})`) : ""}`}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span className="text-lg font-semibold tabular-nums text-slate-900">
          {entry.band ?? "—"}
        </span>
        {/*
          One link per skill, which is the whole of the owner's request: each
          sector can be retaken on its own. It carries the sitting it updates,
          so a band earned here attaches to the right report rather than to
          "your score" in the abstract — see app/exam/page.tsx, which refuses a
          retake naming a sitting the learner does not have.
        */}
        <Link
          href={`/exam?retake=${encodeURIComponent(entry.module)}&of=${encodeURIComponent(reportId)}`}
          className="btn-secondary !min-h-9 !px-3 !py-1 !text-xs"
        >
          {entry.band === null ? "Sit" : "Retake"}
        </Link>
      </span>
    </li>
  );
}

export default function HistoryPage() {
  const profile = useProfile();
  const results = useMemo(() => newestFirst(profile.results), [profile.results]);

  /*
    Derived on every render from the reports and the retakes, never stored.
    That is what makes "recalculated every time a sector is retaken" true by
    construction rather than by remembering to update something: there is no
    second copy of the overall anywhere that could fall behind.
  */
  const standing = useMemo(
    () => standingRecord(profile.mockReports, profile.mockRetakes),
    [profile.mockReports, profile.mockRetakes],
  );

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
    <div className="space-y-3">
      {/*
        Title, the count and the one line of insight all on the same row. They
        were three stacked paragraphs at reading size, which is a lot of prose
        above a page whose point is the numbers underneath it.
      */}
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-[1.375rem]">
          History
        </h1>
        <p className="min-w-0 flex-1 basis-72 text-sm leading-6 text-slate-600">
          {results.length === 0
            ? "Every practice test and its band will be recorded here."
            : `${results.length} recorded sitting${results.length === 1 ? "" : "s"}. Bands are practice estimates, and the trend matters more than any single one.`}
          {line ? <span className="text-slate-700"> {line}</span> : null}
        </p>
        {(results.length > 0 || (profile.mockReports?.length ?? 0) > 0) && (
          <ClearHistoryButton />
        )}
      </header>

      {standing ? (
        <StandingCard record={standing} />
      ) : (
        results.length > 0 && (
          <div className="card">
            <p className="text-[0.9375rem] leading-7 text-slate-600">
              <span className="font-medium text-slate-800">No overall band yet.</span> An overall
              is the mean of four skills measured in one sitting, so it comes from a{" "}
              <Link href="/exam" className="font-medium text-indigo-700 underline underline-offset-2">
                full mock exam
              </Link>
              . After that you can re-sit any single skill and your overall recalculates around
              it, the way IELTS One Skill Retake works.
            </p>
          </div>
        )
      )}

      {results.length === 0 ? (
        standing ? null : (
          <div className="card">
            <p className="text-[0.9375rem] leading-7 text-slate-600">
              Sit any practice test and it lands here automatically —{" "}
              <Link href="/practice" className="font-medium text-indigo-700 underline underline-offset-2">
                start with a reading or listening test
              </Link>
              , or try the writing or speaking examiner.
            </p>
          </div>
        )
      ) : (
        <>
          <section aria-label="Band by module" className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
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

          {(profile.mockReports?.length ?? 0) > 0 && (
            <section>
              <h2 className="heading-rule mb-2 text-sm font-semibold text-slate-900">
                Mock exam reports
              </h2>
              {/*
                Deliberately still the *original* bands, unchanged by any
                retake. A real One Skill Retake issues a new Test Report Form
                and leaves the first one valid — the candidate chooses which to
                send — and this list is the archive of forms as they were
                issued. The card above is the form that stands today. Rewriting
                these rows to match it would destroy the only record of what a
                sitting actually measured, which is the thing this feature is
                least allowed to do.
              */}
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {profile.mockReports?.map((report) => {
                  const retakes = retakesOf(report.id, profile.mockRetakes);
                  return (
                    <Link
                      key={report.id}
                      href={`/exam/report?id=${encodeURIComponent(report.id)}`}
                      className="card premade-glass flex items-center justify-between gap-3 !p-3"
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-slate-900">
                          Full mock exam
                        </span>
                        <span className="block text-xs text-slate-500">
                          {fmtDate(report.completedAt)} ·{" "}
                          {retakes.length === 0
                            ? "Certificate and score report"
                            : `Bands as sat · ${retakes.length} skill${retakes.length === 1 ? "" : "s"} re-sat since`}
                        </span>
                      </span>
                      <span className="shrink-0 text-lg font-semibold tabular-nums text-slate-900">
                        {report.marks.overall ?? "—"}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </section>
          )}

          <section>
            <h2 className="heading-rule mb-2 text-sm font-semibold text-slate-900">Every sitting</h2>
            {/*
              The table is the record — and the fallback for anyone the charts
              fail. It keeps its own scrollbar rather than growing down the
              page, so however many sittings there are, the four panels above
              stay on screen.
            */}
            {/*
              rounded-xl rather than rounded-2xl, and px-5 rather than px-3.

              A 2rem corner against a 12px cell inset put the first row's date
              and its Feedback link inside the curve — measured at a 13px gap
              against a 32px radius, which is what made the text look like it
              was touching the edge. The rows are deliberately full-bleed, so
              the hover highlight reaches the sides; that means the clearance
              has to come from the cells, and the corner has to be small
              enough for a cell inset to clear it.
            */}
            <div className="max-h-[16rem] overflow-y-auto rounded-xl border border-slate-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-2 pl-5 pr-3 font-medium">Date</th>
                    <th className="px-4 py-2 font-medium">Module</th>
                    <th className="hidden px-4 py-2 font-medium sm:table-cell">Test</th>
                    <th className="px-4 py-2 text-right font-medium">Score</th>
                    <th className="px-4 py-2 text-right font-medium">Band</th>
                    <th className="py-2 pl-3 pr-5 text-right font-medium">Feedback</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-surface">
                  {results.map((r, i) => (
                    <tr key={`${r.testId}-${r.date}-${i}`}>
                      <td className="whitespace-nowrap py-2 pl-5 pr-3 text-slate-600">{fmtDate(r.date)}</td>
                      <td className="px-4 py-2 capitalize text-slate-800">{r.module}</td>
                      <td className="hidden max-w-[16rem] truncate px-4 py-2 text-slate-600 sm:table-cell">
                        {r.testTitle}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-600">
                        {r.raw !== undefined && r.total !== undefined ? `${r.raw}/${r.total}` : "—"}
                      </td>
                      <td className="px-4 py-2 text-right font-semibold tabular-nums text-slate-900">
                        {r.band}
                      </td>
                      <td className="py-2 pl-3 pr-5 text-right">
                        {r.review ? (
                          <Link
                            href={`/history/result?module=${encodeURIComponent(r.module)}&test=${encodeURIComponent(r.testId)}&date=${encodeURIComponent(r.date)}`}
                            className="font-medium text-indigo-700 underline underline-offset-2"
                          >
                            View
                          </Link>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <LookupHistoryCard compact />
    </div>
  );
}
