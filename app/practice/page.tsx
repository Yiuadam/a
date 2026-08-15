"use client";

import Link from "next/link";
import { useState } from "react";
import DeleteGenerated from "@/components/DeleteGenerated";
import DoneBadge, { bestResultFor } from "@/components/DoneBadge";
import LockedCard from "@/components/LockedCard";
import MoreComing from "@/components/MoreComing";
import GlassSelect from "@/components/GlassSelect";
import { LISTENING_TESTS, READING_TESTS } from "@/lib/tests";
import SessionCount from "@/components/SessionCount";
import { allowanceFor } from "@/lib/entitlements/sessions";
import { useSessionAccess } from "@/lib/entitlements/useSessions";
import { useProfile } from "@/lib/hooks";
import { questionCount } from "@/lib/questions";
import { postJSON } from "@/lib/api";
import { addGeneratedTest } from "@/lib/store";
import type { GeneratedTest, ListeningTest, ReadingTest } from "@/lib/types";
import LoadingIndicator from "@/components/LoadingIndicator";

const readingTests = READING_TESTS;
const listeningTests = LISTENING_TESTS;

export default function PracticePage() {
  const profile = useProfile();
  const access = useSessionAccess();
  const [genKind, setGenKind] = useState<"reading" | "listening">("reading");
  const [genDifficulty, setGenDifficulty] = useState<"medium" | "hard">("medium");
  const [genTopic, setGenTopic] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  async function generate() {
    setGenerating(true);
    setGenError(null);
    try {
      /*
        postJSON, not fetch. It carries the session token and the iOS API base;
        a bare fetch carried neither, so a signed-in learner was metered as
        anonymous — allowance zero — and told on their first attempt that they
        had used all of today's AI. See lib/api.ts.
      */
      const data = await postJSON<{ kind: GeneratedTest["kind"]; test: GeneratedTest["test"] }>(
        "/api/generate",
        { kind: genKind, difficulty: genDifficulty, topicHint: genTopic || undefined },
      );
      const entry: GeneratedTest = {
        kind: data.kind,
        createdAt: new Date().toISOString(),
        test: data.test,
      };
      addGeneratedTest(entry);
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Generation failed.");
    } finally {
      setGenerating(false);
    }
  }


  /*
    One row per test rather than a card the size of a paragraph. A learner
    choosing a test needs the title, whether they have sat it, and what it will
    cost them in time — three things that fit on two lines, so eight tests fit
    on a screen instead of filling two.
  */
  /*
    How many papers of a skill this account may open, as a count rather than a
    counter.

    "2 left this week" is a number somebody has to hold in their head while
    they scan a list. Locking the papers past the allowance says the same thing
    in the place the decision is made: the ones you can sit look normal, the
    rest wear a padlock, and you can still read every title to see what you
    would be getting. A visitor gets one of each, a free account two.
  */
  /*
    The cap, not what is left of it.

    `left` counts down as papers are sat, so a visitor who had tried both of
    theirs saw every card locked — including the two they had already opened.
    The number that should decide this is how many the tier unlocks at all: one
    for a visitor, two for a free account. The weekly counter is a separate
    idea and lives in the heading.
  */
  const openable = (kind: "reading" | "listening") =>
    allowanceFor(access.tier, kind).perWeek;

  const testRow = (
    kind: "reading" | "listening",
    t: ReadingTest | ListeningTest,
    generated?: boolean,
    index = 0,
  ) => {
    const limit = openable(kind);
    /*
      Locked strictly by position: the first N are open and the rest are not.

      An earlier version exempted any paper already sat, on the reasoning that
      taking one back reads as a punishment. It also meant a visitor who had
      tried two papers could see two unlocked, which is not what "one paper"
      means — the allowance stopped describing anything. Position is the rule a
      learner can predict.
    */
    const beyond = limit !== null && index >= limit;
    const reason = access[kind].reason ?? (access.tier === "anonymous" ? "sign-in" : "subscribe");

    const inner = (
      <>
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="min-w-0 break-words text-sm font-semibold text-slate-900">{t.title}</h3>
          <DoneBadge result={bestResultFor(profile.results, t.id)} />
        </div>
        <p className="mt-0.5 break-words text-xs leading-5 text-slate-600">
          {"topic" in t ? t.topic : t.context}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
          {/* CEFR code first, since it's the scale the placement result already speaks — and
              never lower-cased or capitalised, "B1" is not "b1" title-cased back up. */}
          <span>{t.level}</span>
          <span aria-hidden>·</span>
          <span className="capitalize">{t.difficulty}</span>
          <span aria-hidden>·</span>
          <span>{questionCount(t.questions)} questions</span>
          <span aria-hidden>·</span>
          <span>{t.timeMinutes} min</span>
          {generated && (
            <span className="rounded bg-purple-100 px-1.5 text-purple-700">AI-generated</span>
          )}
        </p>
      </>
    );

    /*
      Not known yet: drawn, dimmed, and not a link. See `pending` in
      lib/entitlements/useSessions.ts — this is the second the account lookup
      takes, and it used to be a second in which everything was openable.
    */
    if (access[kind].pending) {
      return (
        <div key={t.id} className="card relative !p-3 min-w-0 cursor-wait opacity-60" aria-busy="true">
          <LoadingIndicator label="Checking access…" className="absolute right-3 top-3 text-sm text-indigo-600" textClassName="sr-only" />
          {inner}
        </div>
      );
    }

    if (beyond) {
      return (
        <LockedCard key={t.id} reason={reason} label={`${t.title}, a ${kind} paper`} fill>
          <div className="card !p-3 h-full">{inner}</div>
        </LockedCard>
      );
    }

    const link = (
      <Link href={`/practice/${kind}?id=${t.id}`} className="card !p-3 block">
        {inner}
      </Link>
    );

    /* A generated test can be thrown away; a bundled one cannot. The button is
       a sibling of the link, never a child — see DeleteGenerated. */
    if (!generated) return <div key={t.id}>{link}</div>;
    return (
      <div key={t.id} className="relative">
        {link}
        <DeleteGenerated id={t.id} title={t.title} />
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold text-slate-900 sm:text-[22px]">Practice tests</h1>
        <p className="min-w-0 flex-1 basis-72 text-sm leading-6 text-slate-600">
          Real exam format, with band scores.
        </p>
      </div>

      {/*
        The four primary destinations stay above the fold even though the
        paper library below is necessarily long. A learner can enter any skill
        immediately; the detailed paper rows remain available for browsing.
      */}
      <nav
        aria-label="Choose a practice skill"
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
      >
        {[
          ["Listening", "/practice/listening"],
          ["Reading", "/practice/reading"],
          ["Writing", "/practice/writing"],
          ["Speaking", "/speaking"],
        ].map(([label, href]) => (
          <Link
            key={href}
            href={href}
            className="btn-secondary min-w-0 !min-h-12 !px-4 text-center !text-xs sm:!px-5"
          >
            {label}
          </Link>
        ))}
      </nav>

      {/*
        The mock exam sits above the papers rather than among them, because it
        is not another paper. Everything below is one skill with feedback as you
        go; this is the whole exam with no feedback at all until the end. Listed
        as a fifth card it would read as a longer reading test, and somebody
        would start it at half past ten on a weeknight.
      */}
      <Link
        href="/exam"
        className="card !p-3 flex flex-wrap items-center justify-between gap-3 border-indigo-200 bg-indigo-50/40"
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-slate-900">Full mock exam</span>
          <span className="block text-xs leading-5 text-slate-600">
            All four modules in exam order, on the real clock — about three hours. Nothing is
            marked or explained until the end.
          </span>
        </span>
        <span className="btn-secondary shrink-0">Sit the exam</span>
      </Link>

      {/*
        Three columns on a laptop: the two auto-marked papers side by side, and
        the two things you do rather than sit — writing, and generating a fresh
        test — in the third. Below `lg` they stack in the same order.
      */}
      {/*
        Three columns, not four. A fourth was tried and left empty — the page
        has exactly three things in it, and an empty column is worse than a
        wider one. The columns take the extra width instead.
      */}
      <div className="grid gap-3 lg:grid-cols-3">
        <section className="min-w-0">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h2 className="heading-rule text-sm font-semibold text-slate-900">Reading</h2>
            <SessionCount access={access.reading} />
          </div>
          <div className="space-y-2">
            {readingTests.map((t, i) => testRow("reading", t, false, i))}
            {profile.genTests
              .filter((g) => g.kind === "reading")
              .map((g, i) => testRow("reading", g.test, true, readingTests.length + i))}
            <MoreComing what="reading papers" />
          </div>
        </section>

        <section className="min-w-0">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h2 className="heading-rule text-sm font-semibold text-slate-900">Listening</h2>
            <SessionCount access={access.listening} />
          </div>
          <div className="space-y-2">
            {listeningTests.map((t, i) => testRow("listening", t, false, i))}
            {profile.genTests
              .filter((g) => g.kind === "listening")
              .map((g, i) => testRow("listening", g.test, true, listeningTests.length + i))}
            <MoreComing what="listening papers" />
          </div>
        </section>

        <div className="min-w-0 space-y-3">
          <section className="min-w-0">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h2 className="heading-rule text-sm font-semibold text-slate-900">Writing</h2>
              <SessionCount access={access.writing} />
            </div>
            {/*
              The card is drawn either way, and locked over the top when it is
              not available. It is not swapped for a different card: a learner
              deciding whether an account is worth making needs to see what is
              behind the lock. See components/LockedCard.tsx.
            */}
            {access.writing.locked && access.writing.reason ? (
              <LockedCard reason={access.writing.reason} label="Writing practice">
                <div className="card !p-3">
                  <h3 className="text-sm font-semibold text-slate-900">
                    Writing tasks with AI examiner feedback
                  </h3>
                  <p className="mt-0.5 text-xs leading-5 text-slate-600">
                    Task 1 reports and letters, Task 2 essays — graded on all four criteria with a
                    rewritten model paragraph.
                  </p>
                </div>
              </LockedCard>
            ) : (
              <Link href="/practice/writing" className="card !p-3 block">
                <h3 className="text-sm font-semibold text-slate-900">
                  Writing tasks with AI examiner feedback
                </h3>
                <p className="mt-0.5 text-xs leading-5 text-slate-600">
                  Task 1 reports and letters, Task 2 essays — graded on all four criteria with a
                  rewritten model paragraph.
                </p>
              </Link>
            )}
          </section>

          {/*
            Generating a test is an AI call, so it follows the AI rules rather
            than the session rules: a visitor has no model at all, so the panel
            is locked rather than offered and then refused.
          */}
          {access.tier === "anonymous" ? (
            <LockedCard reason="sign-in" label="Generate a fresh test with AI">
              <section id="generate" className="card !p-3 min-w-0 border-indigo-200 bg-indigo-50/40">
            <h2 className="text-sm font-semibold text-slate-900">Generate a fresh test with AI</h2>
            <p className="mt-0.5 text-xs leading-5 text-slate-600">
              Never run out of material — the AI writes a brand-new exam-format test on demand,
              saved on this device.
            </p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1 basis-28 text-xs text-slate-700">
                <span className="mb-0.5 block text-slate-500">Module</span>
                <GlassSelect
                  label="Generated test module"
                  value={genKind}
                  options={[{ value: "reading", label: "Reading" }, { value: "listening", label: "Listening" }]}
                  onValueChange={(value) => setGenKind(value as "reading" | "listening")}
                />
              </div>
              <div className="min-w-0 flex-1 basis-36 text-xs text-slate-700">
                <span className="mb-0.5 block text-slate-500">Difficulty</span>
                <GlassSelect
                  label="Generated test difficulty"
                  value={genDifficulty}
                  options={[{ value: "medium", label: "Medium (5–6.5)" }, { value: "hard", label: "Hard (6.5–8)" }]}
                  onValueChange={(value) => setGenDifficulty(value as "medium" | "hard")}
                  minMenuWidth={164}
                />
              </div>
              <label className="min-w-0 flex-1 basis-40 text-xs text-slate-700">
                <span className="mb-0.5 block text-slate-500">Topic (optional)</span>
                <input
                  className="input !py-2 w-full"
                  placeholder="e.g. space exploration"
                  value={genTopic}
                  onChange={(e) => setGenTopic(e.target.value)}
                />
              </label>
              <button className="btn-primary w-full" onClick={generate} disabled={generating}>
                {generating ? <LoadingIndicator label="Generating (about a minute)…" announce={false} /> : "Generate test"}
              </button>
            </div>
            {genError && <p className="mt-2 text-sm text-rose-600">{genError}</p>}
              </section>
            </LockedCard>
          ) : (
          <section id="generate" className="card !p-3 min-w-0 border-indigo-200 bg-indigo-50/40">
            <h2 className="text-sm font-semibold text-slate-900">Generate a fresh test with AI</h2>
            <p className="mt-0.5 text-xs leading-5 text-slate-600">
              Never run out of material — the AI writes a brand-new exam-format test on demand,
              saved on this device.
            </p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1 basis-28 text-xs text-slate-700">
                <span className="mb-0.5 block text-slate-500">Module</span>
                <GlassSelect
                  label="Generated test module"
                  value={genKind}
                  options={[{ value: "reading", label: "Reading" }, { value: "listening", label: "Listening" }]}
                  onValueChange={(value) => setGenKind(value as "reading" | "listening")}
                />
              </div>
              <div className="min-w-0 flex-1 basis-36 text-xs text-slate-700">
                <span className="mb-0.5 block text-slate-500">Difficulty</span>
                <GlassSelect
                  label="Generated test difficulty"
                  value={genDifficulty}
                  options={[{ value: "medium", label: "Medium (5–6.5)" }, { value: "hard", label: "Hard (6.5–8)" }]}
                  onValueChange={(value) => setGenDifficulty(value as "medium" | "hard")}
                  minMenuWidth={164}
                />
              </div>
              <label className="min-w-0 flex-1 basis-40 text-xs text-slate-700">
                <span className="mb-0.5 block text-slate-500">Topic (optional)</span>
                <input
                  className="input !py-2 w-full"
                  placeholder="e.g. space exploration"
                  value={genTopic}
                  onChange={(e) => setGenTopic(e.target.value)}
                />
              </label>
              <button className="btn-primary w-full" onClick={generate} disabled={generating}>
                {generating ? <LoadingIndicator label="Generating (about a minute)…" announce={false} /> : "Generate test"}
              </button>
            </div>
            {genError && <p className="mt-2 text-sm text-rose-600">{genError}</p>}
          </section>
          )}
        </div>
      </div>
    </div>
  );
}
