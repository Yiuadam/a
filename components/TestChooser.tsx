"use client";

import Link from "next/link";
import LockedCard from "@/components/LockedCard";
import { useSessionAccess } from "@/lib/entitlements/useSessions";
import { useProfile } from "@/lib/hooks";
import { questionCount } from "@/lib/questions";
import { latestFor } from "@/lib/results";
import type { ListeningTest, ReadingTest } from "@/lib/types";

/*
  One skill's papers, and nothing else.

  This is what /practice/reading answers when there is no test id in the URL —
  which is how most people arrive, because it is what the header's "Reading"
  link points at. It used to answer "we couldn't find that test on this
  device", a dead end wearing an error message, and send them to /practice
  where all four skills are listed side by side. Somebody who clicked Reading
  had asked a narrower question than that.

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
}: {
  kind: "reading" | "listening";
  tests: (ReadingTest | ListeningTest)[];
  /** The id that was asked for and did not resolve, if there was one. */
  missingId?: string | null;
}) {
  const profile = useProfile();
  const access = useSessionAccess();
  const skill = access[kind];

  const generated = profile.genTests.filter((g) => g.kind === kind).map((g) => g.test);
  const all = [...tests, ...generated];
  const limit = skill.left;
  const label = kind === "reading" ? "Reading" : "Listening";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold text-slate-900 sm:text-[22px]">{label} practice</h1>
        <p className="min-w-0 flex-1 basis-72 text-sm leading-6 text-slate-600">
          {kind === "reading"
            ? "One academic passage and its questions, marked the moment you submit."
            : "A recording played once, then its questions, marked the moment you submit."}
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
          That test isn&rsquo;t on this device any more — a generated one is only saved in the
          browser that made it. Here is everything else.
        </p>
      )}

      {/*
        min-w-0 on the children, not just here. `truncate` sets
        white-space: nowrap, and a grid item's automatic minimum width is its
        min-content — so an untruncatable title drags the whole column past the
        screen. Caught at 360px by the layout audit, 243px over.
      */}
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {all.map((t, i) => {
          const band = latestFor(profile.results, kind)?.testId === t.id
            ? latestFor(profile.results, kind)?.band
            : profile.results.find((r) => r.testId === t.id)?.band;
          const isGenerated = i >= tests.length;
          const beyond = limit !== null && i >= limit && band === undefined;

          const inner = (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="min-w-0 truncate text-sm font-semibold text-slate-900">{t.title}</h2>
                {band !== undefined && (
                  <span className="shrink-0 rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700">
                    Best band {band}
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-xs leading-5 text-slate-600">
                {"topic" in t ? t.topic : t.context}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                <span className="capitalize">{t.difficulty}</span>
                <span aria-hidden>·</span>
                <span>{questionCount(t.questions)} questions</span>
                <span aria-hidden>·</span>
                <span>{t.timeMinutes} min</span>
                {isGenerated && (
                  <span className="rounded bg-purple-100 px-1.5 text-purple-700">AI-generated</span>
                )}
              </p>
            </>
          );

          if (beyond) {
            const reason = access.tier === "anonymous" ? "sign-in" : "subscribe";
            return (
              <LockedCard key={t.id} reason={reason} label={`${t.title}, a ${kind} paper`}>
                <div className="card !p-3 min-w-0">{inner}</div>
              </LockedCard>
            );
          }

          return (
            <Link key={t.id} href={`/practice/${kind}?id=${t.id}`} className="card !p-3 block min-w-0">
              {inner}
            </Link>
          );
        })}
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
