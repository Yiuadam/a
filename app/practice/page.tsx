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
import UpgradeNotice from "@/components/UpgradeNotice";
import { PaywallError, postJSON } from "@/lib/api";
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
  const [genKind, setGenKind] = useState<"reading" | "listening">("reading");
  const [genDifficulty, setGenDifficulty] = useState<"medium" | "hard">("medium");
  const [genTopic, setGenTopic] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [genPaywalled, setGenPaywalled] = useState<PaywallError | null>(null);

  async function generate() {
    setGenerating(true);
    setGenError(null);
    setGenPaywalled(null);
    try {
      const data = await postJSON<{ kind: GeneratedTest["kind"]; test: GeneratedTest["test"] }>(
        "/api/generate",
        {
          kind: genKind,
          difficulty: genDifficulty,
          topicHint: genTopic || undefined,
        },
      );
      const entry: GeneratedTest = {
        kind: data.kind,
        createdAt: new Date().toISOString(),
        test: data.test,
      };
      addGeneratedTest(entry);
    } catch (err) {
      if (err instanceof PaywallError) setGenPaywalled(err);
      else setGenError(err instanceof Error ? err.message : "Generation failed.");
    } finally {
      setGenerating(false);
    }
  }

  const bestBand = (testId: string) => {
    const bands = profile.results.filter((r) => r.testId === testId).map((r) => r.band);
    return bands.length > 0 ? Math.max(...bands) : undefined;
  };

  const testCard = (
    kind: "reading" | "listening",
    t: ReadingTest | ListeningTest,
    generated?: boolean,
  ) => {
    const band = bestBand(t.id);
    return (
      <Link
        key={t.id}
        href={`/practice/${kind}?id=${t.id}`}
        className="card block transition hover:shadow-md"
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="font-semibold text-slate-900">{t.title}</h3>
            <p className="mt-0.5 text-sm text-slate-600">
              {"topic" in t ? t.topic : t.context}
            </p>
          </div>
          {band !== undefined && (
            <span className="shrink-0 rounded-full bg-indigo-100 px-2.5 py-1 text-xs font-semibold text-indigo-700">
              Best {band}
            </span>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500">
          <span className="rounded bg-slate-100 px-2 py-0.5 capitalize">{t.difficulty}</span>
          <span className="rounded bg-slate-100 px-2 py-0.5">
            {questionCount(t.questions)} questions
          </span>
          <span className="rounded bg-slate-100 px-2 py-0.5">{t.timeMinutes} min</span>
          {generated && (
            <span className="rounded bg-purple-100 px-2 py-0.5 text-purple-700">AI-generated</span>
          )}
        </div>
      </Link>
    );
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-[26px] font-semibold text-slate-900">Practice tests</h1>
        <p className="mt-1 text-sm text-slate-600">
          Exam-format tests scored on the 9-band scale. Reading and listening are auto-marked;
          writing and speaking are graded by the AI examiner against the official criteria.
        </p>
      </div>

      <section>
        <h2 className="heading-rule mb-3 text-base font-semibold text-slate-900">Reading</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {readingTests.map((t) => testCard("reading", t))}
          {profile.genTests
            .filter((g) => g.kind === "reading")
            .map((g) => testCard("reading", g.test, true))}
        </div>
      </section>

      <section>
        <h2 className="heading-rule mb-3 text-base font-semibold text-slate-900">Listening</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {listeningTests.map((t) => testCard("listening", t))}
          {profile.genTests
            .filter((g) => g.kind === "listening")
            .map((g) => testCard("listening", g.test, true))}
        </div>
      </section>

      <section>
        <h2 className="heading-rule mb-3 text-base font-semibold text-slate-900">Writing</h2>
        <Link href="/practice/writing" className="card block transition hover:shadow-md">
          <h3 className="font-semibold text-slate-900">Writing tasks with AI examiner feedback</h3>
          <p className="mt-0.5 text-sm text-slate-600">
            Task 1 reports and letters, Task 2 essays — graded on all four criteria with a
            rewritten model paragraph.
          </p>
        </Link>
      </section>

      <section id="generate" className="card border-indigo-200 bg-indigo-50/40">
        <h2 className="text-base font-semibold text-slate-900">Generate a fresh test with AI</h2>
        <p className="mt-1 text-sm text-slate-600">
          Never run out of practice material — the AI writes a brand-new exam-format test on
          demand. Generated tests are saved on this device.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="text-sm text-slate-700">
            <span className="mb-1 block text-xs text-slate-500">Module</span>
            <select
              className="input"
              value={genKind}
              onChange={(e) => setGenKind(e.target.value as "reading" | "listening")}
            >
              <option value="reading">Reading</option>
              <option value="listening">Listening</option>
            </select>
          </label>
          <label className="text-sm text-slate-700">
            <span className="mb-1 block text-xs text-slate-500">Difficulty</span>
            <select
              className="input"
              value={genDifficulty}
              onChange={(e) => setGenDifficulty(e.target.value as "medium" | "hard")}
            >
              <option value="medium">Medium (band 5–6.5)</option>
              <option value="hard">Hard (band 6.5–8)</option>
            </select>
          </label>
          <label className="flex-1 text-sm text-slate-700">
            <span className="mb-1 block text-xs text-slate-500">Topic (optional)</span>
            <input
              className="input w-full"
              placeholder="e.g. space exploration"
              value={genTopic}
              onChange={(e) => setGenTopic(e.target.value)}
            />
          </label>
          <button className="btn-primary" onClick={generate} disabled={generating}>
            {generating ? "Generating (about a minute)…" : "Generate test"}
          </button>
        </div>
        {genError && <p className="mt-3 text-sm text-rose-600">{genError}</p>}
        {genPaywalled && (
          <div className="mt-3">
            <UpgradeNotice error={genPaywalled} />
          </div>
        )}
      </section>
    </div>
  );
}
