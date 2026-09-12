"use client";

import Link from "next/link";
import { useState, type CSSProperties } from "react";
import DeleteGenerated from "@/components/DeleteGenerated";
import DoneBadge, { bestResultFor } from "@/components/DoneBadge";
import LockedCard from "@/components/LockedCard";
import MoreComing from "@/components/MoreComing";
import NewBadge from "@/components/NewBadge";
import LoadingIndicator from "@/components/LoadingIndicator";
import { paperNeedsNewBadge } from "@/lib/completion-badges";
import { allowanceFor } from "@/lib/entitlements/sessions";
import { useSessionAccess } from "@/lib/entitlements/useSessions";
import { useProfile } from "@/lib/hooks";
import { questionCount } from "@/lib/questions";
import type { ListeningTest, ReadingTest, WritingTask } from "@/lib/types";

/*
  One skill's papers, and nothing else.

  This is what a skill route answers when there is no paper id in the URL —
  which is how most people arrive, because it is what the header's Listening,
  Reading and Writing links point at. Sending them back to /practice, where all
  four skills are listed side by side, would answer a broader question than the
  one they asked.

  How many are openable comes from the same table as everywhere else: a visitor
  gets one, a free account two, a subscriber all of them. The rest are drawn
  with their titles readable behind a lock, because a locked paper you cannot
  read the name of is not an invitation to anything.

  A paper already sat is never locked, whatever the allowance says. Taking one
  back after a learner has finished it would read as a punishment for having
  practised.
*/

/*
  The bar that takes the writing library down to one task number.

  Reading and listening used to carry a bar of their own — three stops, easy
  to hard — and it is gone from every skill it once appeared on. It filtered
  papers by an estimate the app itself had made, offered back to a learner
  dressed as a fact they could rely on. Writing's bar survives because what it
  narrows by is not an estimate: `task` is 1 or 2 because IELTS itself divides
  writing that way, authored on every task and checked at build time
  (scripts/validate-content.mjs), never guessed.

  This used to also carry writing's own estimate — a task *type* (chart,
  table, letter, essay) standing in for the four things a task actually asks a
  candidate to produce, because grouping by IELTS's own Task 1/Task 2 split
  put fifteen of the bank's forty essays behind one stop and nothing else to
  choose from. Task 2 counting double in IELTS scoring is what changed that
  calculus: a candidate who wants to know they are practising enough of the
  half that counts twice needs exactly the split IELTS uses, not a finer one
  invented to make the bar look busier.

  What it does is unchanged from the bar reading and listening used to share:
  a pill that sits on the chosen stop and slides to the next when it is
  tapped.

  Deliberately not the draggable, blooming knob the theme switch and the
  organisation sections use. Those are chrome in a header; this one sits on top
  of a scrolling list of papers, where the gesture it mostly received was a
  thumb beginning a flick down the page.

  Every stop carries its count, including All and including a zero. A count is
  what tells somebody whether the tap is worth making — fifteen Task 2 essays
  is a practice session, and none is a reason to stay where you are — and
  finding that out by tapping and reading an empty screen is the thing this bar
  exists to save.
*/
function WritingTaskFilter({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ id: string; label: string; count: number }>;
  value: string;
  onChange: (value: string) => void;
}) {
  /*
    A plain segmented control: the pill sits on the selected stop and slides
    when another is pressed.

    It used to be the draggable, blooming kind — the knob could be pushed along
    with a finger and swelled while it was held. That is right for the small
    bars in the header, which are chrome; it is wrong here. This one sits at the
    top of a scrolling list of papers, so the gesture it most often received was
    a thumb starting a downward flick on it, and even under `pan-y` a slightly
    diagonal flick was taken as a drag and changed the filter instead of
    scrolling. Nothing on the screen suggested it was draggable either, so the
    swell was an animation that only appeared when something had gone wrong.
  */
  const selectedIndex = Math.max(0, options.findIndex((option) => option.id === value));

  return (
    /*
      No touch-action of its own any more. The bar takes taps and nothing else,
      so every gesture that starts on it belongs to the page underneath — which
      on a list of papers is a scroll.
    */
    <div
      role="tablist"
      aria-label="Task"
      data-writing-task-filter
      className="writing-task-filter-base premade-glass relative grid min-w-0 items-center overflow-hidden rounded-full p-1"
      style={
        {
          "--writing-task-filter-index": selectedIndex,
          "--writing-task-filter-count": options.length,
        } as CSSProperties
      }
    >
      <span className="writing-task-filter-selector" aria-hidden="true" />
      {options.map((option, index) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={value === option.id}
          onClick={() => onChange(option.id)}
          className={`writing-task-filter-option segmented-option relative z-10 flex min-w-0 items-center justify-center gap-1 rounded-full px-1 text-[0.6875rem] font-semibold transition-colors sm:px-2 sm:text-xs ${
            selectedIndex === index ? "text-slate-900" : "text-slate-600 hover:text-slate-900"
          }`}
        >
          <span className="truncate">{option.label}</span>
          {/*
            The count takes the label's own colour at three-quarter strength
            rather than a slate of its own. A fixed grey is what the other bars
            use for their badges, and measured on the knob in the dark theme it
            came out at 2.2:1 against the pill — a number nobody can read is not
            a number. Stepping the label's colour down instead keeps the
            hierarchy in every theme, because it moves with the text it is
            attached to rather than against the surface underneath.
          */}
          <span className="text-[0.625rem] font-medium opacity-75">{option.count}</span>
        </button>
      ))}
    </div>
  );
}

/*
  Reading's own bar: which of the two IELTS Reading papers, Academic or
  General Training, the library below is showing.

  Built separately from `WritingTaskFilter` above rather than by generalising
  it, even though the two look alike, because the two bars are not the same
  shape underneath. Writing's stops narrow one already-unlocked library and
  "All" is a real, useful third stop; Academic and General Training are not
  two slices of one paper a candidate reads either way; they are two
  different exams with different passages and a different question mix, and
  showing both interleaved under an "All" would be exactly the "wade through
  papers meant for the other exam" this bar exists to prevent. So there is no
  "All" here, and the two stops are always both on screen rather than one
  sliding pill among three — a candidate chooses which exam they are
  practising, not how much of it to see.

  `variant` earns this the same way `task` earned writing's bar: it is a
  real, authored property on every reading paper, not an estimate like the
  difficulty bar this file already removed — see `ReadingTest.variant` in
  lib/types.ts.
*/
function ReadingVariantFilter({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ id: ReadingTest["variant"]; label: string; count: number }>;
  value: ReadingTest["variant"];
  onChange: (value: ReadingTest["variant"]) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Reading paper"
      data-reading-variant-filter
      className="inline-flex flex-wrap gap-1 rounded-full border border-slate-200 bg-surface p-1"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={value === option.id}
          onClick={() => onChange(option.id)}
          className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
            value === option.id
              ? "bg-indigo-600 text-white"
              : "text-slate-600 hover:text-slate-900"
          }`}
        >
          <span>{option.label}</span>
          <span className="text-[0.625rem] font-medium opacity-75">{option.count}</span>
        </button>
      ))}
    </div>
  );
}

export default function TestChooser({
  kind,
  tests,
  missingId,
  retainedQuery = "",
}: {
  kind: "reading" | "listening" | "writing";
  tests: (ReadingTest | ListeningTest | WritingTask)[];
  /** The id that was asked for and did not resolve, if there was one. */
  missingId?: string | null;
  /**
   * Context that must survive choosing a paper, such as an organisation
   * assignment opened from a notification. `id` is always replaced below.
   */
  retainedQuery?: string;
}) {
  const profile = useProfile();
  const access = useSessionAccess();
  /*
    Held in the component and nowhere else, so every arrival starts on All.

    A remembered filter is a filter somebody set once and is now being shown
    through without having asked — which is the same complaint as starting
    filtered, only a week later and harder to notice, because by then the bar
    is the only thing saying why half the library is missing. It also does not
    fit either half of how this app stores things: lib/progress/storage.ts
    keeps a learner's work per tab and their device settings in localStorage,
    and a scan of a list on the way to picking a paper is neither.

    The cost is one tap. Sit a Task 2, come back for another, and the bar is
    on All again. Worth saying plainly, because the fix — putting the choice
    in the URL, where the back button would restore it — is a real option that
    was not taken here.
  */
  const [filter, setFilter] = useState("all");
  /*
    Reading's own choice, kept apart from `filter` above rather than folded
    into it — the two answer different questions (writing narrows an already
    unlocked library, reading decides which of two different exams is on
    screen at all) and a shared variable would make one stop, "all" mean
    "all writing tasks" while a filter of "academic" meant "only Academic
    reading", which is not one vocabulary. Same reasoning as `filter` for why
    it lives here and nowhere else: every arrival opens on Academic, which is
    also the paper the exam start screen opens on by default, so a candidate
    coming from `/practice` and one coming from `/exam` land on the same
    library.
  */
  const [readingVariant, setReadingVariant] = useState<ReadingTest["variant"]>("academic");

  const generated = kind === "writing"
    ? []
    : profile.genTests.filter((g) => g.kind === kind).map((g) => g.test);
  const all: (ReadingTest | ListeningTest | WritingTask)[] = [...tests, ...generated];
  /*
    Position is fixed here, before anything is filtered out, because two rules
    below are counted from it: which papers the tier has unlocked, and which
    were generated on this device. Numbering a narrowed list instead would hand
    a visitor the first Task 2 as their one free opening simply because they
    had tapped it.
  */
  const entries = all.map((paper, index) => ({ paper, index }));
  /*
    Writing is the only skill left with anything to narrow by. `task` is
    always 1 or 2 — never a third value a paper could be typo'd into and
    silently drop out of every stop but All — so the two stops are written out
    rather than built from a shared vocabulary the way the old bar's were.
  */
  const writingTaskOptions = kind === "writing"
    ? ([1, 2] as const).map((taskNumber) => ({
        id: String(taskNumber),
        label: `Task ${taskNumber}`,
        /* Counted across the whole library, locked papers included: a
           padlocked paper is still on the screen with its title readable, so
           leaving it out would make the count disagree with what the stop
           actually shows. */
        count: entries.filter(({ paper }) => (paper as WritingTask).task === taskNumber).length,
      }))
    : [];
  /*
    Reading's two stops, the same shape as writing's above but never
    including "All" — see ReadingVariantFilter below for why there is
    nothing to add one to.
  */
  const readingVariantOptions = kind === "reading"
    ? (["academic", "general"] as const).map((v) => ({
        id: v,
        label: v === "academic" ? "Academic" : "General Training",
        count: entries.filter(({ paper }) => (paper as ReadingTest).variant === v).length,
      }))
    : [];
  const shown = kind === "writing" && filter !== "all"
    ? entries.filter(({ paper }) => String((paper as WritingTask).task) === filter)
    : kind === "reading"
      ? entries.filter(({ paper }) => (paper as ReadingTest).variant === readingVariant)
      : entries;
  /* The cap the tier unlocks, not what is left of it — see app/practice/page.tsx. */
  const limit = allowanceFor(access.tier, kind).perWeek;
  const label = kind === "reading" ? "Reading" : kind === "listening" ? "Listening" : "Writing";

  return (
    /*
      The practice routes lock the outer viewport while an exam is running,
      but this component is the paper library, not an exam. The body therefore
      cannot be its scroll container. Give the library its own full-height
      scroller so every paper remains reachable on a phone while the sticky
      site header stays fixed.
    */
    <div
      /*
        The paper library has its own width, and used to stop at max-w-7xl —
        1280px — with nothing past it. These three routes are viewport-locked,
        so AppMain contributes no width at all and this cap was the only one in
        play: at 2560px the library sat in 1280px with 640px of empty paper down
        each side, narrower even than the /practice hub beside it. It grows now,
        the same way the rest of the product does.
      */
      className="mx-auto h-full w-full max-w-7xl space-y-4 overflow-y-auto overscroll-y-contain px-4 py-5 sm:px-6 2xl:max-w-[96rem] min-[1920px]:max-w-[116rem]"
      data-paper-chooser
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold text-slate-900 sm:text-[1.375rem]">{label} practice</h1>
        <p className="min-w-0 flex-1 basis-72 text-sm leading-6 text-slate-600">
          {kind === "reading"
            ? "Read one passage, answer the questions, and get your band as soon as you submit."
            : kind === "listening"
              ? "Listen to a recording, answer the questions, and get your band as soon as you submit."
              : "Choose a task, write your response, and get examiner-style feedback when marking is included."}
        </p>
      </div>

      {/*
        A genuinely missing id still says so. That case is real — a stale
        bookmark, or a generated test cleared from this browser — and quietly
        showing a list instead would leave somebody hunting for a paper that no
        longer exists.
      */}
      {missingId && (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-900">
          {kind === "writing" ? (
            <>That writing task isn&rsquo;t available. Here are the other tasks.</>
          ) : (
            <>That test isn&rsquo;t on this device any more — a generated one is only saved in the
              browser that made it. Here is everything else.</>
          )}
        </p>
      )}

      {/* Its own row above the cards rather than beside the heading: at 390px
          three stops need the whole line, and a control that changes what
          the list below it contains belongs directly above that list. Writing
          and reading each have one now — listening has nothing left to narrow
          by. How wide it is allowed to grow past a phone is in globals.css. */}
      {kind === "writing" && (
        <WritingTaskFilter
          options={[{ id: "all", label: "All", count: all.length }, ...writingTaskOptions]}
          value={filter}
          onChange={setFilter}
        />
      )}
      {kind === "reading" && (
        <ReadingVariantFilter
          options={readingVariantOptions}
          value={readingVariant}
          onChange={setReadingVariant}
        />
      )}

      {/*
        A stop with nothing under it says so. The bar has already put a zero on
        that stop, but landing on a screen holding nothing but "more coming"
        and having to work out that it was the filter is a worse few seconds
        than a sentence. Above the grid rather than inside it, because the grid
        gives every row a fixed ten rem and a sentence does not want one.

        Listening-only exclusion now: it alone has nothing to filter, so
        `shown` can only be empty for it if the library itself is — a case
        with nothing to reset, so there is nothing useful to say here.
      */}
      {kind === "writing" && shown.length === 0 && (
        <p
          data-writing-task-filter-empty
          className="rounded-xl border border-slate-200 bg-surface px-3 py-2 text-sm leading-6 text-slate-600"
        >
          {filter === "all" ? "There are no writing tasks yet." : `There are no Task ${filter} tasks yet.`}{" "}
          Choose All to see everything there is.
        </p>
      )}
      {kind === "reading" && shown.length === 0 && (
        <p
          data-reading-variant-filter-empty
          className="rounded-xl border border-slate-200 bg-surface px-3 py-2 text-sm leading-6 text-slate-600"
        >
          {`There are no ${readingVariant === "academic" ? "Academic" : "General Training"} reading papers yet.`}{" "}
          Choose the other tab to see what is available.
        </p>
      )}

      {/* min-w-0 and break-words keep long titles inside the column without
          replacing meaningful words with an ellipsis. */}
      <div /* A fourth column past 1536px and a fifth past 1920, so a wider window shows
             more papers rather than wider ones — a paper card is a title and two
             short lines, and stretching it only adds whitespace after the text. */
          className="practice-paper-grid grid gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 min-[1920px]:grid-cols-5">
        {shown.map(({ paper: t, index: i }) => {
          const isGenerated = i >= tests.length;
          /* Strictly by position — see app/practice/page.tsx for why. */
          const beyond = limit !== null && i >= limit;

          const best = bestResultFor(profile.results, t.id);
          const writingTask = kind === "writing" ? (t as WritingTask) : null;
          const objectiveTest = kind === "writing" ? null : (t as ReadingTest | ListeningTest);

          const inner = (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="min-w-0 break-words text-sm font-semibold text-slate-900">{t.title}</h2>
                {paperNeedsNewBadge(profile.results, t.id) ? (
                  <NewBadge />
                ) : (
                  <DoneBadge result={best} />
                )}
              </div>
              <p className="mt-0.5 break-words text-xs leading-5 text-slate-600">
                {writingTask
                  ? `Task ${writingTask.task} · ${writingTask.variant === "academic" ? "Academic" : "General Training"}`
                  : objectiveTest && "topic" in objectiveTest
                    ? objectiveTest.topic
                    : objectiveTest?.context}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                {writingTask ? (
                  <>
                    <span>At least {writingTask.minWords} words</span>
                    <span aria-hidden>·</span>
                    <span>{writingTask.timeMinutes} min</span>
                  </>
                ) : (
                  <>
                    {/* CEFR code first, since it's the scale the placement result already speaks —
                        and never lower-cased or capitalised, "B1" is not "b1" title-cased back up.
                        No difficulty word beside it any more: it was an estimate printed as though
                        it were a fact, and the CEFR level is the one honest scale a learner can
                        actually place themselves on. */}
                    <span>{objectiveTest?.level}</span>
                    <span aria-hidden>·</span>
                    <span>{objectiveTest ? questionCount(objectiveTest.questions) : 0} questions</span>
                    <span aria-hidden>·</span>
                    <span>{t.timeMinutes} min</span>
                  </>
                )}
                {isGenerated && (
                  <span className="rounded bg-purple-100 px-1.5 text-purple-700">AI-generated</span>
                )}
              </p>
            </>
          );

          /* Not known yet — inert, not open. See app/practice/page.tsx. */
          if (access[kind].pending) {
            return (
              <div
                key={t.id}
                className="practice-paper-card card relative min-w-0 cursor-wait opacity-60"
                aria-busy="true"
              >
                <LoadingIndicator label="Checking access…" className="absolute right-3 top-3 text-sm text-indigo-600" textClassName="sr-only" />
                {inner}
              </div>
            );
          }

          if (beyond) {
            const reason = access.tier === "anonymous" ? "sign-in" : "subscribe";
            return (
              <LockedCard key={t.id} reason={reason} label={`${t.title}, a ${kind} paper`} fill>
                <div className="practice-paper-card card h-full min-w-0">{inner}</div>
              </LockedCard>
            );
          }

          const link = (
            <Link
              href={(() => {
                const query = new URLSearchParams(retainedQuery);
                query.set("id", t.id);
                return `/practice/${kind}?${query.toString()}`;
              })()}
              className="practice-paper-card card block min-w-0"
            >
              {inner}
            </Link>
          );

          /* Only the generated ones can be thrown away, and the button is a
             sibling of the link rather than a child — see DeleteGenerated. */
          if (!isGenerated) return <div key={t.id} className="h-full min-w-0">{link}</div>;
          return (
            <div key={t.id} className="relative h-full min-w-0">
              {link}
              <DeleteGenerated id={t.id} title={t.title} />
            </div>
          );
        })}

        {/* Last in the grid, so it is what you reach after the final paper. */}
        <MoreComing what={kind === "writing" ? "writing tasks" : `${kind} papers`} />
      </div>

      <p className="text-sm text-slate-500">
        <Link href="/practice" className="font-medium text-indigo-700 underline underline-offset-2">
          All practice tests
        </Link>
        {" · "}
        <Link href="/plan" className="font-medium text-indigo-700 underline underline-offset-2">
          What to do next
        </Link>
      </p>
    </div>
  );
}
