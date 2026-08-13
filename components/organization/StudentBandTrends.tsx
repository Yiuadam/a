import type { StudentHistory } from "@/lib/organizations/types";
import {
  ORGANIZATION_BAND_SKILLS,
  organizationBandSeries,
  type OrganizationBandPoint,
  type OrganizationBandSkill,
} from "@/lib/organizations/trends";
import { formatDate, titleCase } from "./OrganizationUI";

const CHART_WIDTH = 220;
const CHART_HEIGHT = 42;
const CHART_PAD_X = 5;
const CHART_PAD_Y = 5;

function coordinates(points: readonly OrganizationBandPoint[]): Array<{ x: number; y: number }> {
  const usableWidth = CHART_WIDTH - CHART_PAD_X * 2;
  const usableHeight = CHART_HEIGHT - CHART_PAD_Y * 2;
  return points.map((point, index) => ({
    x: points.length === 1 ? CHART_WIDTH / 2 : CHART_PAD_X + (index / (points.length - 1)) * usableWidth,
    y: CHART_HEIGHT - CHART_PAD_Y - (point.band / 9) * usableHeight,
  }));
}

function signedChange(value: number): string {
  if (value === 0) return "No change";
  return `${value > 0 ? "+" : ""}${value.toFixed(1).replace(/\.0$/, "")} since first sitting`;
}

function description(skill: OrganizationBandSkill, points: readonly OrganizationBandPoint[]): string {
  if (points.length === 0) return `No scored ${skill} sittings.`;
  return points.map((point) => `${formatDate(point.submittedAt)}: band ${point.band}`).join("; ");
}

function BandTrendCard({
  skill,
  points,
  fallbackBand,
  selected,
  onSelect,
}: {
  skill: OrganizationBandSkill;
  points: readonly OrganizationBandPoint[];
  fallbackBand: number | undefined;
  selected: boolean;
  onSelect: (skill: OrganizationBandSkill) => void;
}) {
  const plotted = coordinates(points);
  const path = plotted.map((point) => `${point.x},${point.y}`).join(" ");
  const latest = points.at(-1)?.band ?? fallbackBand;
  const change = points.length > 1 ? points.at(-1)!.band - points[0].band : null;
  const skillLabel = titleCase(skill);
  const chartDescription = description(skill, points);

  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`Show ${skillLabel} sittings`}
      className={`card min-w-0 w-full overflow-hidden text-left transition-colors !rounded-[clamp(.75rem,2vw,var(--radius-lg))] !p-[clamp(.35rem,1.25vw,.625rem)] ${selected ? "border-indigo-400/80 bg-indigo-50/45 ring-2 ring-indigo-500/20" : "hover:bg-surface/50"}`}
      onClick={() => onSelect(skill)}
    >
      <div className="flex items-start justify-between gap-2">
        <span>
          <span className="block truncate text-[clamp(8px,2.5vw,12px)] font-semibold leading-tight text-slate-600">{skillLabel}</span>
          <span className="mt-0.5 hidden text-[9px] text-slate-500 sm:block">
            {points.length} scored sitting{points.length === 1 ? "" : "s"}
          </span>
        </span>
        <span className="text-[clamp(.875rem,3.8vw,1.125rem)] font-semibold leading-none tabular-nums text-slate-900">{latest ?? "—"}</span>
      </div>

      <svg
        role="img"
        aria-label={`${skillLabel} score trend. ${chartDescription}`}
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="mt-1 h-[clamp(1.7rem,6vw,2.5rem)] w-full overflow-visible"
        preserveAspectRatio="none"
      >
        <title>{`${skillLabel} score trend`}</title>
        <desc>{chartDescription}</desc>
        {[0, 4.5, 9].map((band) => {
          const y = CHART_HEIGHT - CHART_PAD_Y - (band / 9) * (CHART_HEIGHT - CHART_PAD_Y * 2);
          return <line key={band} x1={CHART_PAD_X} x2={CHART_WIDTH - CHART_PAD_X} y1={y} y2={y} className="stroke-slate-300/55" strokeWidth="1" />;
        })}
        {plotted.length > 1 && (
          <polyline
            points={path}
            fill="none"
            className="stroke-indigo-600"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {plotted.map((point, index) => (
          <circle
            key={points[index].attemptId}
            cx={point.x}
            cy={point.y}
            r={index === plotted.length - 1 ? 3.5 : 2.5}
            className="fill-surface stroke-indigo-600"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>

      <div className="mt-0.5 min-h-3 truncate text-[clamp(7px,1.8vw,9px)] leading-3 text-slate-500">
        <span className="sm:hidden">{change === null ? (points.length === 0 ? "None" : "First") : `${change > 0 ? "+" : ""}${change.toFixed(1).replace(/\.0$/, "")}`}</span>
        <span className="hidden sm:inline">{change === null ? (points.length === 0 ? "No trend yet" : "First score") : signedChange(change)}</span>
        {points.length > 0 && <span className="hidden shrink-0 lg:float-right lg:block">{formatDate(points.at(-1)!.submittedAt)}</span>}
      </div>
    </button>
  );
}

export default function StudentBandTrends({
  history,
  selectedSkill,
  onSelectSkill,
}: {
  history: StudentHistory;
  selectedSkill: OrganizationBandSkill | null;
  onSelectSkill: (skill: OrganizationBandSkill) => void;
}) {
  const series = organizationBandSeries(history.attempts);
  return (
    <section aria-labelledby="student-progress-heading">
      <div className="mb-2 flex items-end justify-between gap-3 px-1">
        <div>
          <h2 id="student-progress-heading" className="text-[15px] font-semibold text-slate-900">Score trends</h2>
          <p className="text-[11px] text-slate-500">All saved sittings, oldest to newest.</p>
        </div>
        <span className="text-[10px] text-slate-500">IELTS band 0–9</span>
      </div>
      <div className="grid grid-cols-2 gap-[clamp(.25rem,1vw,.5rem)] sm:grid-cols-4">
        {ORGANIZATION_BAND_SKILLS.map((skill) => (
          <BandTrendCard
            key={skill}
            skill={skill}
            points={series[skill]}
            fallbackBand={history.student.latestBands[skill]}
            selected={selectedSkill === skill}
            onSelect={onSelectSkill}
          />
        ))}
      </div>
    </section>
  );
}
