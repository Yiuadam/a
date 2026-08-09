"use client";

import Link from "next/link";
import { useState } from "react";
import readingOne from "@/data/reading-1.json";
import readingTwo from "@/data/reading-2.json";
import readingThree from "@/data/reading-3.json";
import readingFour from "@/data/reading-4.json";
import listeningOne from "@/data/listening-1.json";
import listeningTwo from "@/data/listening-2.json";
import listeningThree from "@/data/listening-3.json";
import listeningFour from "@/data/listening-4.json";
import LockedCard from "@/components/LockedCard";
import SessionCount from "@/components/SessionCount";
import { useSessionAccess } from "@/lib/entitlements/useSessions";
import { useProfile } from "@/lib/hooks";
import { questionCount } from "@/lib/questions";
import { addGeneratedTest } from "@/lib/store";
import type { GeneratedTest, ListeningTest, ReadingTest } from "@/lib/types";

const readingTests = [readingOne, readingThree, readingTwo, readingFour] as ReadingTest[];
const listeningTests = [
  listeningOne,
  listeningThree,
  listeningTwo,
  listeningFour,
] as ListeningTest[];

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
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: genKind,
          difficulty: genDifficulty,
          topicHint: genTopic || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Generation failed.");
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

  const bestBand = (testId: string) => {
    const bands = profile.results.filter((r) => r.testId === testId).map((r) => r.band);
    return bands.length > 0 ? Math.max(...bands) : undefined;
  };

  /*
    One row per test rather than a card the size of a paragraph. A learner
    choosing a test needs the title, whether they have sat it, and what it will
    cost them in time — three things that fit on two lines, so eight tests fit
    on a screen instead of filling two.
  */
  const testRow = (
    kind: "reading" | "listening",
    t: ReadingTest | ListeningTest,
    generated?: boolean,
  ) => {
    const band = bestBand(t.id);
    return (
      <Link key={t.id} href={`/practice/${kind}?id=${t.id}`} className="card !p-3 block">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="min-w-0 truncate text-sm font-semibold text-slate-900">{t.title}</h3>
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
          {generated && (
            <span className="rounded bg-purple-100 px-1.5 text-purple-700">AI-generated</span>
          )}
        </p>
      </Link>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold text-slate-900 sm:text-[22px]">Practice tests</h1>
        <p className="min-w-0 flex-1 basis-72 text-sm leading-6 text-slate-600">
          Exam-format tests on the 9-band scale — reading and listening auto-marked, writing and
          speaking graded by the AI examiner.
        </p>
      </div>

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
            {readingTests.map((t) => testRow("reading", t))}
            {profile.genTests
              .filter((g) => g.kind === "reading")
              .map((g) => testRow("reading", g.test, true))}
          </div>
        </section>

        <section className="min-w-0">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h2 className="heading-rule text-sm font-semibold text-slate-900">Listening</h2>
            <SessionCount access={access.listening} />
          </div>
          <div className="space-y-2">
            {listeningTests.map((t) => testRow("listening", t))}
            {profile.genTests
              .filter((g) => g.kind === "listening")
              .map((g) => testRow("listening", g.test, true))}
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

          <section id="generate" className="card !p-3 min-w-0 border-indigo-200 bg-indigo-50/40">
            <h2 className="text-sm font-semibold text-slate-900">Generate a fresh test with AI</h2>
            <p className="mt-0.5 text-xs leading-5 text-slate-600">
              Never run out of material — the AI writes a brand-new exam-format test on demand,
              saved on this device.
            </p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="min-w-0 flex-1 basis-28 text-xs text-slate-700">
                <span className="mb-0.5 block text-slate-500">Module</span>
                <select
                  className="input !py-2 w-full"
                  value={genKind}
                  onChange={(e) => setGenKind(e.target.value as "reading" | "listening")}
                >
                  <option value="reading">Reading</option>
                  <option value="listening">Listening</option>
                </select>
              </label>
              <label className="min-w-0 flex-1 basis-36 text-xs text-slate-700">
                <span className="mb-0.5 block text-slate-500">Difficulty</span>
                <select
                  className="input !py-2 w-full"
                  value={genDifficulty}
                  onChange={(e) => setGenDifficulty(e.target.value as "medium" | "hard")}
                >
                  <option value="medium">Medium (5–6.5)</option>
                  <option value="hard">Hard (6.5–8)</option>
                </select>
              </label>
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
                {generating ? "Generating (about a minute)…" : "Generate test"}
              </button>
            </div>
            {genError && <p className="mt-2 text-sm text-rose-600">{genError}</p>}
          </section>
        </div>
      </div>
    </div>
  );
}
