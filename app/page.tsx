"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import BandBadge from "@/components/BandBadge";
import { useProfile } from "@/lib/hooks";
import { newestFirst } from "@/lib/results";
import LockedCard from "@/components/LockedCard";
import { useSessionAccess } from "@/lib/entitlements/useSessions";
import type { ModuleName } from "@/lib/types";
import { Icon } from "@/components/Icons";
import RefractiveGlassLayer from "@/components/RefractiveGlassLayer";
import NewBadge from "@/components/NewBadge";
import IntentPrefetchLink from "@/components/IntentPrefetchLink";
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
    <p className="dashboard-card-blurb mt-0.5 text-sm leading-5 text-slate-600 sm:text-xs">
      <span className="dashboard-card-blurb-short">{short}</span>
      <span className="dashboard-card-blurb-full">{full}</span>
    </p>
  );
}

export default function Dashboard() {
  const profile = useProfile();
  const scores = useSyncExternalStore(subscribeDrills, drillScores, getServerDrillScores);
  const access = useSessionAccess();
  const placement = profile.placement;
  const recent = newestFirst(profile.results).slice(0, 6);

  return (
    <div className="dashboard-screen h-full overflow-hidden px-4 py-3 sm:px-5 sm:py-5">
      {/*
        One card, one obvious next step — and now one row of it. The welcome
        used to be a paragraph and a 96px band badge stacked above everything
        else, which cost a third of a laptop screen before the first link.
      */}
      <section className="card premade-glass p-4 flex flex-wrap items-center justify-between gap-x-5 gap-y-3 sm:p-5">
        <RefractiveGlassLayer />
        <div className="premade-glass-content min-w-0 flex-1 basis-64">
          {/*
            A first-time visitor is told what this is before being told what to
            do, and the product is named rather than assumed.

            It read "Let's find your band score." — warm, and it only works if
            you already know where you are. Somebody arriving cold from a link
            got a dashboard for an app whose name and purpose appeared nowhere
            on the page. Google's OAuth reviewer was the first to say so out
            loud, refusing to verify the consent screen on two counts: the
            homepage "does not explain the purpose of your app", and the name
            on it did not match the name asking for consent. Both were fair.

            A returning learner still gets "Welcome back." — they know what
            BandUp is, and re-introducing it every visit would be the other
            mistake.
          */}
          <h1 className="text-xl font-semibold leading-snug text-slate-900 sm:text-[22px]">
            BandUp
          </h1>
          <p className="mt-1 text-sm leading-5 text-slate-600">
            An IELTS learning and practice app with a placement test and personal study plan.
          </p>
          <p className="dashboard-summary mt-1 text-sm leading-6 text-slate-600">
            {placement
              ? `Around band ${placement.band}. Your plan says what to do next.`
              : "Find your band score in five minutes, get a study plan built around it, and " +
                "practise listening, reading, writing and speaking with an AI examiner."}
          </p>
        </div>
        <div className="premade-glass-content flex flex-wrap items-center gap-2">
          {placement && (
            <span className="mr-1 flex items-center gap-2">
              <BandBadge band={placement.band} size="sm" />
              <span className="text-xs leading-4 text-slate-500">
                Current
                <br />
                estimate
              </span>
            </span>
          )}
          {placement ? (
            <>
              <IntentPrefetchLink href="/plan" className="btn-primary premade-glass">
                <RefractiveGlassLayer radius={999} />
                <span className="premade-glass-content">See what to do next</span>
              </IntentPrefetchLink>
              <IntentPrefetchLink href="/placement" className="btn-secondary premade-glass">
                <RefractiveGlassLayer radius={999} />
                <span className="premade-glass-content">Re-test</span>
              </IntentPrefetchLink>
            </>
          ) : (
              <IntentPrefetchLink href="/placement" className="dashboard-placement-button btn-primary premade-glass">
                <RefractiveGlassLayer radius={16} />
                <span className="premade-glass-content">Start the 5-minute test</span>
              </IntentPrefetchLink>
          )}
        </div>
      </section>

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
      <div className="grid gap-4 lg:grid-cols-3">
        {/*
          Two thirds when there is something in the third column, all three
          when there is not.

          The right column only renders once a learner has practised. Before
          that the left column was still spanning 2 of 3, so a new account got
          its six tiles squeezed into two thirds of the page with 524px of
          nothing beside them — measured at 1920px. The grid was reserving room
          for a section that had decided not to appear.
        */}
        <div
          className={`dashboard-sections min-w-0 space-y-4 ${recent.length > 0 ? "lg:col-span-2" : "lg:col-span-3"}`}
        >
          <section>
            <h2 className="heading-rule mb-2.5 text-sm font-semibold text-slate-900">
              Practise a skill
            </h2>
            {/*
              Two-up on a phone, four-up from xl. More columns rather than
              wider cards: a tile is a title and one line, and stretching it to
              600px makes an icon with a lot of whitespace after it, not a
              better tile.
            */}
            <div className="dashboard-card-grid dashboard-practice-grid grid grid-cols-2 gap-3 md:grid-cols-4">
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
                    <div key={m.key} className="dashboard-skill-card card premade-glass p-3.5 cursor-wait opacity-60" aria-busy="true">
                      <RefractiveGlassLayer />
                      <div className="premade-glass-content flex items-start gap-2.5">
                        <Icon name={m.icon} className="dashboard-card-icon mt-0.5 h-5 w-5 shrink-0 text-indigo-600" />
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
                        <RefractiveGlassLayer />
                        <div className="premade-glass-content flex items-start gap-2.5">
                          <Icon name={m.icon} className="dashboard-card-icon mt-0.5 h-5 w-5 shrink-0 text-indigo-600" />
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
                    <RefractiveGlassLayer />
                    <div className="premade-glass-content flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-start gap-2.5">
                        <Icon name={m.icon} className="dashboard-card-icon mt-0.5 h-5 w-5 shrink-0 text-indigo-600" />
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
                    <RefractiveGlassLayer />
                    <div className="premade-glass-content flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-start gap-2.5">
                        <Icon name={s.icon} className="dashboard-card-icon mt-0.5 h-5 w-5 shrink-0 text-indigo-600" />
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
          <section className="dashboard-recent min-w-0 lg:col-span-1">
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
