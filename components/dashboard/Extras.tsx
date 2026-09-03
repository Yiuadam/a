"use client";

import { useEffect, useState } from "react";

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
}: {
  title: string;
  icon: CardIconName;
  figure: string;
  note: string;
  href: string;
  action: string;
  /* True when the figure is a placeholder rather than a measurement. */
  muted?: boolean;
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
      <p className="mt-1.5 min-w-0 flex-1 text-[0.8125rem] leading-5 text-slate-500">{note}</p>
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
  const count =
    now === null ? 0 : profile.results.filter((r) => new Date(r.date).getTime() >= since).length;
  return (
    <Tile
      title="This week"
      icon="practice"
      figure={`${count}`}
      muted={count === 0}
      note={count === 0 ? "No sittings in the last seven days." : "Sittings in the last seven days."}
      href="/history"
      action="See your history"
    />
  );
}

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
  const last = newestFirst(profile.results)[0];
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
