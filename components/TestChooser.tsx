"use client";

import Link from "next/link";
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

  const generated = kind === "writing"
    ? []
    : profile.genTests.filter((g) => g.kind === kind).map((g) => g.test);
  const all: (ReadingTest | ListeningTest | WritingTask)[] = [...tests, ...generated];
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
      className="mx-auto h-full w-full max-w-7xl space-y-4 overflow-y-auto overscroll-y-contain px-4 py-5 sm:px-6"
      data-paper-chooser
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold text-slate-900 sm:text-[22px]">{label} practice</h1>
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

      {/* min-w-0 and break-words keep long titles inside the column without
          replacing meaningful words with an ellipsis. */}
      <div className="practice-paper-grid grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {all.map((t, i) => {
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
                        and never lower-cased or capitalised, "B1" is not "b1" title-cased back up. */}
                    <span>{objectiveTest?.level}</span>
                    <span aria-hidden>·</span>
                    <span className="capitalize">{objectiveTest?.difficulty}</span>
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
                className="practice-paper-card card relative !p-3 min-w-0 cursor-wait opacity-60"
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
                <div className="practice-paper-card card !p-3 h-full min-w-0">{inner}</div>
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
              className="practice-paper-card card !p-3 block min-w-0"
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
