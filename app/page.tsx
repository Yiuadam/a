"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import BandBadge from "@/components/BandBadge";
import { useProfile } from "@/lib/hooks";
import { isValidPlacement } from "@/lib/placement";
import { newestFirst, seriesFor } from "@/lib/results";
import LockedCard from "@/components/LockedCard";
import FreeProPoster from "@/components/billing/FreeProPoster";
import { useSessionAccess } from "@/lib/entitlements/useSessions";
import type { ModuleName, ModuleResult, PlacementResult } from "@/lib/types";
import { Icon } from "@/components/Icons";
import CardIcon from "@/components/CardIcon";
import Scoreboard from "@/components/dashboard/Scoreboard";
import TutorCard from "@/components/dashboard/TutorCard";
import PlanCard from "@/components/dashboard/PlanCard";
import NewBadge from "@/components/NewBadge";
import LoadingIndicator from "@/components/LoadingIndicator";
import IntentPrefetchLink from "@/components/IntentPrefetchLink";
import {
  authedFetch,
  getServerSnapshot as getSessionServerSnapshot,
  getSnapshot as getSessionSnapshot,
  subscribe as subscribeSession,
} from "@/lib/account";
import { apiUrl } from "@/lib/api";
import {
  homeOrganizationShortcutFromResponse,
  type HomeOrganizationShortcut,
} from "@/lib/dashboard-home";
import {
  drillSectionNeedsNewBadge,
  moduleNeedsNewBadge,
  type DrillBadgeKind,
} from "@/lib/completion-badges";
import {
  drillScores,
  getServerDrillScores,
  subscribeDrills,
} from "@/lib/drills";

const MODULES: { key: ModuleName; label: string; href: string; shortBlurb: string; blurb: string; icon: string }[] = [
  {
    key: "listening",
    label: "Listening",
    /* The skill's own page, not the index. Tapping Listening and landing on a
       page listing reading and writing too is answering a wider question than
       the one that was asked. */
    href: "/practice/listening",
    shortBlurb: "Audio and questions",
    blurb: "Audio played once, then questions",
    icon: "listening",
  },
  {
    key: "reading",
    label: "Reading",
    href: "/practice/reading",
    shortBlurb: "Passages and questions",
    blurb: "Real passages, real question types",
    icon: "reading",
  },
  {
    key: "writing",
    label: "Writing",
    href: "/practice/writing",
    shortBlurb: "Timed essay practice",
    blurb: "An essay, marked like the exam",
    icon: "writing",
  },
  {
    key: "speaking",
    label: "Speaking",
    href: "/speaking",
    shortBlurb: "AI speaking interview",
    blurb: "Talk to an AI examiner, get a band",
    icon: "speaking",
  },
];

/* Study sections rather than exam papers: no clock, no band, just the rule. */
const STUDY = [
  {
    key: "grammar" as DrillBadgeKind,
    href: "/grammar",
    label: "Grammar",
    shortBlurb: "Rules and drills",
    blurb: "Ten topics, rule then drill",
    icon: "grammar",
  },
  {
    key: "vocabulary" as DrillBadgeKind,
    href: "/vocabulary",
    label: "Vocabulary",
    shortBlurb: "Words and collocations",
    blurb: "Collocations and word families",
    icon: "vocabulary",
  },
];

function CardBlurb({ short, full }: { short: string; full: string }) {
  return (
    <p className="dashboard-card-blurb mt-0.5 truncate text-sm leading-5 text-slate-600 sm:text-xs">
      <span className="dashboard-card-blurb-short">{short}</span>
      <span className="dashboard-card-blurb-full">{full}</span>
    </p>
  );
}

const TREND_MODULES: {
  key: ModuleName;
  label: string;
  stroke: string;
  icon: string;
}[] = [
  { key: "listening", label: "Listening", stroke: "var(--color-indigo-600)", icon: "listening" },
  { key: "reading", label: "Reading", stroke: "var(--color-indigo-600)", icon: "reading" },
  { key: "writing", label: "Writing", stroke: "var(--color-indigo-600)", icon: "writing" },
  { key: "speaking", label: "Speaking", stroke: "var(--color-indigo-600)", icon: "speaking" },
];

function roleLabel(role: HomeOrganizationShortcut["role"]): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function useHomeOrganizationShortcut(): HomeOrganizationShortcut | null {
  const session = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionServerSnapshot,
  );
  const [resolved, setResolved] = useState<{
    token: string | null;
    shortcut: HomeOrganizationShortcut | null;
  }>({ token: null, shortcut: null });

  useEffect(() => {
    if (!session) return;
    const token = session.accessToken;
    const controller = new AbortController();
    authedFetch(apiUrl("/api/organization/shortcut"), {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => response.ok ? response.json() : null)
      .then((portal: unknown) => {
        if (!controller.signal.aborted) {
          setResolved({ token, shortcut: homeOrganizationShortcutFromResponse(portal) });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setResolved({ token, shortcut: null });
      });
    return () => controller.abort();
  }, [session]);

  return session && resolved.token === session.accessToken ? resolved.shortcut : null;
}

function OrganisationHero({ organization }: { organization: HomeOrganizationShortcut }) {
  const counts = [
    organization.studentCount === null
      ? null
      : `${organization.studentCount} student${organization.studentCount === 1 ? "" : "s"}`,
    organization.memberCount === null
      ? null
      : `${organization.memberCount} member${organization.memberCount === 1 ? "" : "s"}`,
  ].filter((value): value is string => value !== null);

  return (
    <IntentPrefetchLink
      href={`/organization?organization=${encodeURIComponent(organization.id)}`}
      className="dashboard-organization-card card premade-glass block min-w-0 shrink-0 p-4 sm:p-5"
      aria-label={`Open ${organization.name} organisation dashboard`}
    >
      <div className="premade-glass-content flex min-w-0 items-center justify-between gap-4">
        <span className="flex min-w-0 items-center gap-3">
          <CardIcon name="organization" size={28} />
          <span className="min-w-0">
            <span className="block text-xs font-semibold uppercase tracking-[0.16em] text-indigo-700">
              Your organisation
            </span>
            <h1 className="mt-0.5 truncate text-xl font-semibold text-slate-900 sm:text-[1.375rem]">
              {organization.name}
            </h1>
            <span className="mt-0.5 block truncate text-sm text-slate-600">
              {[roleLabel(organization.role), ...counts].join(" · ")}
            </span>
          </span>
        </span>
        <span className="shrink-0 text-right text-sm font-semibold text-indigo-700">
          <span className="hidden sm:inline">Open dashboard </span>→
        </span>
      </div>
    </IntentPrefetchLink>
  );
}

function trendPoints(series: readonly ModuleResult[]): string {
  const points = series.slice(-8);
  if (points.length < 2) return "";
  const bands = points.map((result) => result.band);
  const lo = Math.min(...bands);
  const hi = Math.max(...bands);
  const span = hi === lo ? 1 : hi - lo;
  return points.map((result, index) => {
    const x = 4 + (112 * index) / (points.length - 1);
    const y = hi === lo ? 16 : 28 - ((result.band - lo) / span) * 24;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function ScoreTrendCard({
  module,
  label,
  icon,
  stroke,
  results,
}: {
  module: ModuleName;
  label: string;
  icon: string;
  stroke: string;
  results: readonly ModuleResult[];
}) {
  const series = seriesFor(results, module);
  const latest = series.at(-1);
  const points = trendPoints(series);
  return (
    <IntentPrefetchLink
      href={`/history?module=${module}`}
      className="dashboard-trend-card card premade-glass block min-w-0 p-3.5"
      aria-label={`Open ${label} score history`}
    >
      <span className="premade-glass-content block min-w-0">
        <span className="flex items-start justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <Icon name={icon} className="h-5 w-5 shrink-0 text-indigo-600" />
            <span className="truncate text-sm font-semibold text-slate-900">{label}</span>
          </span>
          <span className="shrink-0 text-lg font-semibold tabular-nums text-slate-900">
            {latest?.band ?? "—"}
          </span>
        </span>
        <span className="mt-0.5 block text-xs text-slate-500">
          {series.length === 0
            ? "No practice score yet"
            : `${series.length} sitting${series.length === 1 ? "" : "s"} · latest band`}
        </span>
        <svg
          viewBox="0 0 120 32"
          preserveAspectRatio="none"
          className="mt-2 h-8 w-full"
          role="img"
          aria-label={series.length === 0
            ? `${label}: no practice scores yet`
            : `${label}: ${series.length} recorded sittings, latest band ${latest?.band}`}
        >
          <path d="M4 28 H116" fill="none" stroke="var(--glass-edge)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          {points ? (
            <polyline
              points={points}
              fill="none"
              stroke={stroke}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ) : latest ? (
            <circle cx="60" cy="16" r="2.5" fill={stroke} />
          ) : null}
        </svg>
      </span>
    </IntentPrefetchLink>
  );
}

function ScoreTrendOverview({
  placement,
  results,
}: {
  placement: PlacementResult;
  results: readonly ModuleResult[];
}) {
  return (
    <section className="dashboard-score-overview min-w-0 shrink-0" aria-labelledby="dashboard-score-heading">
      <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2.5">
          <BandBadge band={placement.band} size="sm" />
          <span className="min-w-0">
            <h1 id="dashboard-score-heading" className="truncate text-xl font-semibold text-slate-900 sm:text-[1.375rem]">
              Your score trends
            </h1>
            <span className="block text-xs text-slate-500">Placement band {placement.band}</span>
          </span>
        </span>
        <span className="flex flex-wrap items-center justify-end gap-2">
          <IntentPrefetchLink href="/plan" className="btn-primary premade-glass shrink-0 whitespace-nowrap">
            <span className="premade-glass-content">See what to do next</span>
          </IntentPrefetchLink>
          <IntentPrefetchLink href="/placement" className="btn-secondary premade-glass shrink-0 whitespace-nowrap">
            <span className="premade-glass-content">Re-test</span>
          </IntentPrefetchLink>
        </span>
      </div>
      <div className="dashboard-trend-grid grid min-w-0 grid-cols-2 gap-2.5 lg:grid-cols-4">
        {TREND_MODULES.map(({ key, ...module }) => (
          <ScoreTrendCard key={key} {...module} module={key} results={results} />
        ))}
      </div>
    </section>
  );
}

export default function Dashboard() {
  const profile = useProfile();
  const scores = useSyncExternalStore(subscribeDrills, drillScores, getServerDrillScores);
  const access = useSessionAccess();
  const placement = profile.placement;
  const organization = useHomeOrganizationShortcut();
  const recent = newestFirst(profile.results).slice(0, 6);
  return (
    <div className="dashboard-screen overflow-x-clip px-4 py-3 sm:px-5 sm:py-5">
      {/*
        One card, one obvious next step — and now one row of it. The welcome
        used to be a paragraph and a 96px band badge stacked above everything
        else, which cost a third of a laptop screen before the first link.
      */}

      {/*
        Practice, study and history side by side on a laptop rather than three
        full-width bands stacked down the page. Below `lg` they fall back to
        stacking, but the tiles themselves stay two-up even on the narrowest
        phone — a tile is a title, one line and an icon, which fits in half a
        390px screen and halves the height of the page.
      */}
      {/*
        min-w-0 on both columns, and it is load-bearing rather than tidy.

        A grid item's automatic minimum width is its min-content, not zero. The
        left column holds a two-up card grid whose min-content is the widest
        unbreakable thing inside it, and on a 390px phone that came to 531px —
        so the column refused to shrink and 141px of it sat off the right edge
        of the screen. Nothing scrolled, because the body has no
        overflow-x: hidden and the page simply drew outside itself; the cards
        were cut in half and every automated check stayed green.

        min-w-0 removes that floor and lets the column be as narrow as the
        screen. Every grid or flex child in this app that contains a grid needs
        it, which is the same trap /practice hit at 390px.
      */}
      {/*
        A working column and a rail beside it, from xl up.

        Before this the page was one row of wide, short tiles with the rest of
        a 1080px screen empty underneath — the thing the owner circled. The
        right column existed but only appeared once a learner had practised, so
        the case that needed it most, a first visit, was exactly the case that
        never got it.

        Now the rail always has something in it: the offer or the score summary
        moves in from the top of the page, and recent practice joins it as soon
        as there is any. The main column gets its width back and its tiles stop
        being letterboxes.
      */}
      {/*
        The board: four modules, two by two, filling one screen and no more.

        On a large display the dashboard used to be a row of wide short tiles
        with most of a 1080px screen empty underneath — and the tiles named the
        same six places the rail beside them now names permanently. Naming them
        twice is what left nothing to put in the space.

        So the tiles go, on a screen that has the rail, and the space carries
        what a dashboard is for: the offer or the score summary, where the
        learner stands, what to do next, and the tutor that can answer why.
        Below `lg` there is no rail, the tiles are the only way through, and
        the page is exactly what it was.
      */}
      <div className="hidden gap-4 lg:grid lg:grid-cols-2 lg:gap-5">
        <div className="min-w-0">
        {organization ? (
          <OrganisationHero organization={organization} />
        ) : isValidPlacement(placement) ? (
          <ScoreTrendOverview placement={placement} results={profile.results} />
        ) : (
          /*
            The free Pro trial poster stands in the placement-test card's own
            slot, always — not offered as a modal over this page, and not
            moved to /pricing, where the people this is for never look.

            It replaces the placement-test card specifically rather than
            sitting beside it: this slot is the one guaranteed to be seen by
            a first-time visitor and a fresh account alike, exactly the
            audience this offer is for, and the 5-minute test is still one
            tap away from the practice tiles and from /placement directly —
            it is only this hero position that changed hands.

            Drawing here has nothing to do with `organization`/`placement`
            state; a returning account with a real placement never reaches
            this branch and never sees the poster stack up beside a trend
            chart it does not belong next to. The component decides its own
            content from there — a guest sees the pitch and a "Sign up free"
            button, a signed-in account sees the real accept flow, and a
            dismissed or already-decided account renders nothing at all, at
            which point nothing stands in this slot either.

            The app's own name used to be this branch's visible page title,
            in PlacementHero. It still has to appear as an <h1> here — Google's
            OAuth review matches the exact application name against one on the
            consent screen's calling page — but the poster's own heading is
            what a reader should actually see now, so this one is sr-only
            rather than reintroducing a second visible title above it.
          */
          <>
            <h1 className="sr-only">BandUp</h1>
            <FreeProPoster />
          </>
        )}
        </div>

        <Scoreboard results={profile.results} />
        <TutorCard />
        <PlanCard profile={profile} />
      </div>

      {/* Below `lg`: no rail, so the tiles are still the way through. */}
      <div className="grid gap-4 lg:hidden">
        <div className="dashboard-sections min-w-0 space-y-4">
          <section>
            <h2 className="heading-rule mb-2.5 text-sm font-semibold text-slate-900">
              Practise a skill
            </h2>
            {/*
              Two-up on a phone, four-up from md — and back to two-up from xl,
              where the column is eight twelfths rather than the whole page.
              Four across a two-thirds column is what was truncating these:
              "Real passages, real ques…", "An essay, marked like th…". A tile
              whose one line of description does not fit is not a tile, and the
              fix is fewer columns rather than shorter words.
            */}
            <div className="dashboard-card-grid dashboard-practice-grid grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-2 xl:gap-4">
              {MODULES.map((m) => {
                const isNew = moduleNeedsNewBadge(profile, m.key);
                const skill = access[m.key];

                /*
                  The same lock as /practice, on the same skills, because a
                  learner meets these cards first. A door that is locked should
                  look locked wherever you find it — being told on the
                  dashboard that Writing is available and discovering one page
                  later that it is not is worse than never offering it.
                */
                if (skill.pending) {
                  return (
                    <div key={m.key} className="dashboard-skill-card card premade-glass relative p-3.5 cursor-wait opacity-60" aria-busy="true">
                      <LoadingIndicator label="Checking access…" className="absolute right-3 top-3 z-10 text-sm text-indigo-600" textClassName="sr-only" />
                      <div className="premade-glass-content flex items-start gap-2.5">
                        <Icon name={m.icon} className="dashboard-card-icon h-5 w-5 shrink-0 text-indigo-600" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <h3 className="text-base font-semibold text-slate-900 sm:text-sm">{m.label}</h3>
                            <NewBadge show={isNew} />
                          </div>
                          <CardBlurb short={m.shortBlurb} full={m.blurb} />
                        </div>
                      </div>
                    </div>
                  );
                }

                if (skill.locked && skill.reason) {
                  return (
                    <LockedCard key={m.key} reason={skill.reason} label={`${m.label} practice`} fill>
                      <div className="dashboard-skill-card card premade-glass p-3.5 h-full">
                        <div className="premade-glass-content flex items-start gap-2.5">
                          <Icon name={m.icon} className="dashboard-card-icon h-5 w-5 shrink-0 text-indigo-600" />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <h3 className="text-base font-semibold text-slate-900 sm:text-sm">{m.label}</h3>
                              <NewBadge show={isNew} />
                            </div>
                            <CardBlurb short={m.shortBlurb} full={m.blurb} />
                          </div>
                        </div>
                      </div>
                    </LockedCard>
                  );
                }

                return (
                  <IntentPrefetchLink
                    key={m.key}
                    href={m.href}
                    className="dashboard-skill-card card premade-glass p-3.5 block"
                  >
                    <div className="premade-glass-content flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-start gap-2.5">
                        <Icon name={m.icon} className="dashboard-card-icon h-5 w-5 shrink-0 text-indigo-600" />
                        <div className="min-w-0">
                          <h3 className="text-base font-semibold text-slate-900 sm:text-sm">{m.label}</h3>
                          <CardBlurb short={m.shortBlurb} full={m.blurb} />
                        </div>
                      </div>
                      {/*
                        No band on the card.

                        It used to show the last band as a bare number in a
                        pill, which nobody could read: a lone figure beside a
                        heading looks like a count of something — tests taken,
                        questions left — and a low band makes that worse,
                        because "2" reads far more like two of a thing than
                        like a score. Labelling it "Band 2" fixed the ambiguity
                        and made the card wordier for a number that is not what
                        the card is for. The card is a door into a skill;
                        History and the dashboard hero are where scores belong,
                        and both say what they mean.
                      */}
                      <NewBadge show={isNew} />
                    </div>
                  </IntentPrefetchLink>
                );
              })}
            </div>
          </section>

          <section>
            <h2 className="heading-rule mb-2.5 text-sm font-semibold text-slate-900">
              Study the language itself
            </h2>
            <div className="dashboard-card-grid dashboard-study-grid grid grid-cols-2 gap-3">
              {STUDY.map((s) => {
                const isNew = drillSectionNeedsNewBadge(scores, s.key);
                return (
                  <IntentPrefetchLink key={s.href} href={s.href} className="dashboard-skill-card card premade-glass p-3.5 block">
                    <div className="premade-glass-content flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-start gap-2.5">
                        <Icon name={s.icon} className="dashboard-card-icon h-5 w-5 shrink-0 text-indigo-600" />
                        <div className="min-w-0">
                          <h3 className="text-base font-semibold text-slate-900 sm:text-sm">{s.label}</h3>
                          <CardBlurb short={s.shortBlurb} full={s.blurb} />
                        </div>
                      </div>
                      <NewBadge show={isNew} />
                    </div>
                  </IntentPrefetchLink>
                );
              })}
            </div>
          </section>
        </div>

        {recent.length > 0 && (
          <section className="dashboard-recent min-w-0 lg:col-span-1 xl:col-span-4 xl:col-start-9 xl:row-start-2">
            <div className="mb-2.5 flex items-baseline justify-between gap-3">
              <h2 className="heading-rule flex-1 text-sm font-semibold text-slate-900">
                Your recent practice
              </h2>
              <Link
                href="/history"
                prefetch={false}
                className="shrink-0 text-xs font-medium text-indigo-700 underline underline-offset-2"
              >
                All history →
              </Link>
            </div>
            {/*
              Six sittings in a fixed-height list. Anything older is one tap
              away in History, and the list scrolls inside itself rather than
              pushing the rest of the page down the screen.
            */}
            <ul className="max-h-[13rem] space-y-1.5 overflow-hidden sm:max-h-[20rem]">
              {recent.map((r, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-surface px-3.5 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-800">{r.testTitle}</p>
                    <p className="text-xs text-slate-500">
                      <span className="capitalize">{r.module}</span>
                      {r.raw !== undefined && r.total !== undefined
                        ? ` · ${r.raw} of ${r.total} correct`
                        : ""}
                      {" · "}
                      {new Date(r.date).toLocaleDateString()}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-indigo-50 px-2.5 py-0.5 text-sm font-semibold text-indigo-700">
                    {r.band}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
