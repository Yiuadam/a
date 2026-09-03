"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import IntentPrefetchLink from "@/components/IntentPrefetchLink";
import CardIcon, { type CardIconName } from "@/components/CardIcon";
import { newestFirst } from "@/lib/results";
import { LISTENING_TESTS, READING_TESTS } from "@/lib/tests";
import type { ModuleName, ModuleResult, Profile } from "@/lib/types";

/*
  Ten more modules for the board, all of them built from what the app already
  knows.

  The rule they share, and the reason they are small: a module earns its place
  by answering one question at a glance. Anything that needs a paragraph to
  explain itself belongs on a page. So each of these is a figure and a line
  saying what the figure means, and every one of them is honest about having no
  data — a learner who has done nothing sees an invitation, never a zero
  dressed up as a score.

  Nothing here fetches. They read the profile the dashboard already has, which
  is what keeps a board of four from being four requests.
*/

/** The shell every module below shares: a heading, a figure, a line, a way in. */
function Tile({
  title,
  icon,
  figure,
  note,
  href,
  action,
  muted = false,
  detail,
}: {
  title: string;
  icon: CardIconName;
  figure: string;
  note: string;
  href: string;
  action: string;
  /* True when the figure is a placeholder rather than a measurement. */
  muted?: boolean;
  /*
    What fills the space between the note and the button.

    Every tile is the same height, because the board's rows are, and a tile
    whose whole content is one number and one short line spent that height on
    nothing — a big figure, a caption, and then a hand's width of empty card
    above the button. The figure is the headline; this is the rest of the
    story, and a module that has one should tell it.
  */
  detail?: ReactNode;
}) {
  return (
    <section className="card flex h-full min-w-0 flex-col !p-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <h2 className="text-[0.9375rem] font-semibold text-slate-900">{title}</h2>
        <CardIcon name={icon} size={20} />
      </div>
      <p
        className={`mt-1 text-[2.25rem] font-semibold leading-none tabular-nums ${
          muted ? "text-slate-300" : "text-slate-900"
        }`}
      >
        {figure}
      </p>
      <p className="mt-1.5 min-w-0 text-[0.8125rem] leading-5 text-slate-500">{note}</p>
      <div className="mt-2 min-w-0 flex-1">{detail}</div>
      <IntentPrefetchLink href={href} className="btn-secondary mt-3 w-full !min-h-9 text-[0.875rem]">
        {action}
      </IntentPrefetchLink>
    </section>
  );
}

const DAY = 86_400_000;

/*
  Today, read after mount rather than during render.

  `Date.now()` in a render body is an impure call — the lint rule that catches
  it is not being fussy, it is describing a real bug: the server renders one
  day, the browser may render another, and React reconciles two different
  answers. Reading it in an effect means the first paint shows the same thing
  the server sent and the real figure arrives a frame later, which for a streak
  or a seven-day count nobody will see.

  `null` until then, and every caller treats that as "no answer yet" rather
  than as zero — a dashboard that flashes 0 before showing 12 has told the
  learner something false, however briefly.
*/
function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    /*
      A frame later rather than synchronously. Setting state inside an effect
      body makes React render, commit and immediately render again — harmless
      once, and the lint rule that objects is right that it is a habit worth
      not having. A clock nobody is watching to the millisecond can wait for
      the next frame, and the cancel keeps a component that unmounts in that
      frame from setting state after it has gone.
    */
    const frame = requestAnimationFrame(() => setNow(Date.now()));
    return () => cancelAnimationFrame(frame);
  }, []);
  return now;
}

/** Calendar days, not elapsed hours: two sittings either side of midnight are two days. */
function dayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

export function StreakCard({ profile }: { profile: Profile }) {
  const now = useNow();
  const days = new Set(profile.results.map((r) => dayKey(r.date)));
  let streak = 0;
  for (let i = 0; now !== null; i += 1) {
    const day = new Date(now - i * DAY).toISOString().slice(0, 10);
    if (!days.has(day)) {
      /*
        Today not being in the set does not break a streak — it is not over
        yet. Any other gap does.
      */
      if (i === 0) continue;
      break;
    }
    streak += 1;
  }
  return (
    <Tile
      title="Your streak"
      icon="history"
      figure={streak > 0 ? `${streak}` : "—"}
      muted={streak === 0}
      note={
        streak === 0
          ? "Sit anything today and the count starts."
          : `${streak === 1 ? "Day" : "Consecutive days"} with at least one sitting.`
      }
      href="/practice"
      action="Practise today"
    />
  );
}

export function ThisWeekCard({ profile }: { profile: Profile }) {
  const now = useNow();
  const since = (now ?? 0) - 7 * DAY;
  const week = now === null ? [] : profile.results.filter((r) => new Date(r.date).getTime() >= since);
  const count = week.length;

  /*
    A bar a day, oldest on the left — how many, not merely whether.

    "3 sittings this week" and "one on each of three days" are very different
    weeks, and the number alone cannot tell them apart. A row of on/off marks
    fixed that much and no more: it still drew a day with four sittings exactly
    as it drew a day with one. Heights say which, and the shape of the week —
    building up, tailing off, one heroic Sunday — is the thing somebody is
    actually looking for on a practice dashboard.
  */
  const days =
    now === null
      ? []
      : Array.from({ length: 7 }, (_, i) => {
          const end = now - (6 - i) * DAY;
          const start = end - DAY;
          return {
            key: end,
            label: new Date(end).toLocaleDateString(undefined, { weekday: "narrow" }),
            n: week.filter((r) => {
              const at = new Date(r.date).getTime();
              return at > start && at <= end;
            }).length,
          };
        });
  /* The tallest bar fills the track, so a quiet week is still legible rather
     than seven slivers against an invisible ceiling. */
  const peak = Math.max(1, ...days.map((day) => day.n));

  const byModule = MODULE_ORDER.map((module) => ({
    module,
    n: week.filter((r) => r.module === module).length,
  })).filter((entry) => entry.n > 0);

  return (
    <Tile
      title="This week"
      icon="practice"
      figure={`${count}`}
      muted={count === 0}
      note={count === 0 ? "No sittings in the last seven days." : "Sittings in the last seven days."}
      href="/history"
      action="See your history"
      detail={
        days.length === 0 ? null : (
          <div className="space-y-2">
            <ol className="flex items-end gap-1">
              {days.map((day) => (
                <li key={day.key} className="flex min-w-0 flex-1 flex-col items-center">
                  <span className="sr-only">
                    {day.label}: {day.n} {day.n === 1 ? "sitting" : "sittings"}
                  </span>
                  {/*
                    A fixed track with the bar grown from the bottom, so seven
                    days line up on one baseline whatever the numbers are. A day
                    with nothing keeps a hairline rather than disappearing —
                    a missing bar and a zero bar look the same, and only one of
                    them is true.
                  */}
                  <span aria-hidden className="flex h-9 w-full items-end">
                    <span
                      className={`block w-full rounded-sm ${
                        day.n > 0 ? "bg-indigo-500" : "bg-slate-200"
                      }`}
                      style={{ height: day.n > 0 ? `${Math.max(12, (day.n / peak) * 100)}%` : "2px" }}
                    />
                  </span>
                  <span aria-hidden className="mt-1 block text-[0.625rem] uppercase text-slate-400">
                    {day.label}
                  </span>
                </li>
              ))}
            </ol>
            {byModule.length > 0 && (
              <p className="text-[0.8125rem] leading-5 text-slate-600">
                {byModule.map((entry) => `${MODULE_LABEL[entry.module]} ${entry.n}`).join(" · ")}
              </p>
            )}
          </div>
        )
      }
    />
  );
}

/* Exam order, so a week's breakdown reads the way the paper is sat. */
const MODULE_ORDER: ModuleName[] = ["listening", "reading", "writing", "speaking"];

const MODULE_LABEL: Record<ModuleName, string> = {
  listening: "Listening",
  reading: "Reading",
  writing: "Writing",
  speaking: "Speaking",
};

const MODULE_HREF: Record<ModuleName, string> = {
  listening: "/practice/listening",
  reading: "/practice/reading",
  writing: "/practice/writing",
  speaking: "/speaking",
};

function latestBands(results: readonly ModuleResult[]): { module: ModuleName; band: number }[] {
  const out: { module: ModuleName; band: number }[] = [];
  /* Named `skill` rather than `module`: assigning to `module` at file scope is
     what Next's no-assign-module-variable rule is about, and a loop binding of
     that name trips it even where nothing is being reassigned. */
  for (const skill of Object.keys(MODULE_LABEL) as ModuleName[]) {
    const latest = newestFirst(results.filter((r) => r.module === skill))[0];
    if (latest) out.push({ module: skill, band: latest.band });
  }
  return out;
}

export function WeakestCard({ profile }: { profile: Profile }) {
  const bands = latestBands(profile.results);
  const weakest = bands.slice().sort((a, b) => a.band - b.band)[0];
  return (
    <Tile
      title="Weakest skill"
      icon="plan"
      figure={weakest ? String(weakest.band) : "—"}
      muted={!weakest}
      note={
        weakest
          ? `${MODULE_LABEL[weakest.module]} is your lowest band. It is the one worth an evening.`
          : "Sit one of each and the lowest appears here."
      }
      href={weakest ? MODULE_HREF[weakest.module] : "/practice"}
      action={weakest ? `Practise ${MODULE_LABEL[weakest.module].toLowerCase()}` : "Start practising"}
    />
  );
}

export function StrongestCard({ profile }: { profile: Profile }) {
  const bands = latestBands(profile.results);
  const best = bands.slice().sort((a, b) => b.band - a.band)[0];
  return (
    <Tile
      title="Strongest skill"
      icon="history"
      figure={best ? String(best.band) : "—"}
      muted={!best}
      note={
        best
          ? `${MODULE_LABEL[best.module]} is your highest band. Keep it there.`
          : "Sit one of each and the highest appears here."
      }
      href="/history"
      action="See the trend"
    />
  );
}

export function TargetCard({ profile }: { profile: Profile }) {
  const bands = latestBands(profile.results);
  const target = profile.targetBand ?? 7;
  const current =
    bands.length === 4
      ? Math.round((bands.reduce((sum, b) => sum + b.band, 0) / 4) * 2) / 2
      : null;
  const gap = current === null ? null : Math.round((target - current) * 10) / 10;
  return (
    <Tile
      title="To your target"
      icon="plan"
      figure={gap === null ? "—" : gap <= 0 ? "There" : `+${gap}`}
      muted={gap === null}
      note={
        gap === null
          ? `Your target is ${target}. Sit all four skills to see the distance.`
          : gap <= 0
            ? `You are at or past band ${target}.`
            : `Bands to find before you reach ${target}.`
      }
      href="/plan"
      action="Open your plan"
    />
  );
}

export function SittingsCard({ profile }: { profile: Profile }) {
  const total = profile.results.length;
  return (
    <Tile
      title="Papers sat"
      icon="practice"
      figure={`${total}`}
      muted={total === 0}
      note={total === 0 ? "Nothing sat yet." : "Marked sittings on this account, all time."}
      href="/history"
      action="See your history"
    />
  );
}

export function LastSittingCard({ profile }: { profile: Profile }) {
  const ordered = newestFirst(profile.results);
  const last = ordered[0];
  /*
    The one before it in the same skill, which is what "better or worse" can
    honestly be measured against. Comparing a reading band with the writing
    band that happened to come before it would be arithmetic on two different
    scales, and it would read as progress or a slump depending on the order
    somebody happened to practise in.
  */
  const previous = last ? ordered.slice(1).find((r) => r.module === last.module) : undefined;
  const change = last && previous ? Math.round((last.band - previous.band) * 10) / 10 : null;

  return (
    <Tile
      title="Last sitting"
      icon="history"
      figure={last ? String(last.band) : "—"}
      muted={!last}
      note={
        last
          ? `${last.testTitle} · ${new Date(last.date).toLocaleDateString()}`
          : "Your most recent band will show here."
      }
      href="/history"
      action="Open it again"
      detail={
        last ? (
          <dl className="space-y-1 text-[0.8125rem] leading-5">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-slate-500">Skill</dt>
              <dd className="font-medium text-slate-800">{MODULE_LABEL[last.module]}</dd>
            </div>
            {last.raw !== undefined && last.total !== undefined && (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-slate-500">Marks</dt>
                <dd className="font-medium tabular-nums text-slate-800">
                  {last.raw} of {last.total}
                </dd>
              </div>
            )}
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-slate-500">
                {previous ? `On your last ${MODULE_LABEL[last.module].toLowerCase()}` : "First one"}
              </dt>
              <dd
                className={`font-medium tabular-nums ${
                  change === null
                    ? "text-slate-400"
                    : change > 0
                      ? "text-emerald-600"
                      : change < 0
                        ? "text-rose-600"
                        : "text-slate-500"
                }`}
              >
                {change === null
                  ? "—"
                  : change === 0
                    ? "no change"
                    : `${change > 0 ? "+" : ""}${change}`}
              </dd>
            </div>
          </dl>
        ) : null
      }
    />
  );
}

export function MockExamCard({ profile }: { profile: Profile }) {
  const sat = (profile.mockReports ?? []).length;
  return (
    <Tile
      title="Full mock exam"
      icon="mock"
      figure={sat > 0 ? `${sat}` : "3h"}
      muted={sat === 0}
      note={
        sat === 0
          ? "All four skills, real timings, results only at the end."
          : `Full sittings completed. The band is the average of four.`
      }
      href="/exam"
      action={sat === 0 ? "Sit the exam" : "Sit another"}
    />
  );
}

/*
  Papers you have not sat, counted rather than asserted.

  This replaced a "Guides" module whose figure was the word "How" — which is
  the test a module has to pass: if there is no number, it is a link with a
  card drawn round it, and the rail already has links. This one answers
  something a learner actually wonders on a Tuesday evening: is there anything
  left, and where.
*/
export function PapersLeftCard({ profile }: { profile: Profile }) {
  const sat = new Set(profile.results.map((r) => r.testId));
  const total = READING_TESTS.length + LISTENING_TESTS.length;
  const left = [...READING_TESTS, ...LISTENING_TESTS].filter((test) => !sat.has(test.id)).length;
  return (
    <Tile
      title="Papers left"
      icon="practice"
      figure={`${left}`}
      muted={left === 0}
      note={
        left === 0
          ? `All ${total} reading and listening papers sat. More are written regularly.`
          : `Reading and listening papers you have not sat, of ${total}.`
      }
      href="/practice"
      action="Pick one"
    />
  );
}
