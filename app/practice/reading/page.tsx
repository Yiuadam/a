"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useState } from "react";
import BandBadge from "@/components/BandBadge";
import Review from "@/components/Review";
import TestQuestions, {
  type AnswerMap,
  type CheckedMap,
} from "@/components/TestQuestions";
import Timer from "@/components/Timer";
import readingOne from "@/data/reading-1.json";
import readingTwo from "@/data/reading-2.json";
import readingThree from "@/data/reading-3.json";
import readingFour from "@/data/reading-4.json";
import readingFive from "@/data/reading-5.json";
import { testAdvice } from "@/lib/advice";
import { isCorrect, rawToBand } from "@/lib/band";
import { useMounted, useProfile } from "@/lib/hooks";
import { flatQuestions, questionCount } from "@/lib/questions";
import { buildReview, joinWithAnd, questionTypeNames } from "@/lib/review";
import { addResult } from "@/lib/store";
import type { ReadingTest } from "@/lib/types";

const bundled = [readingOne, readingTwo, readingThree, readingFour, readingFive] as ReadingTest[];

function ReadingTestPageRunner() {
  const params = useSearchParams();
  const profile = useProfile();
  const mounted = useMounted();
  const [started, setStarted] = useState(false);
  // Exam practice and study practice are different activities; a clock helps
  // the first and gets in the way of the second.
  const [mode, setMode] = useState<"timed" | "free">("timed");
  const [answers, setAnswers] = useState<AnswerMap>({});
  // Questions the learner marked mid-test. Checking locks the answer, so a
  // checked question still counts exactly as it stood when it was checked.
  const [checked, setChecked] = useState<CheckedMap>({});
  const [submitted, setSubmitted] = useState(false);
  const [band, setBand] = useState<number | null>(null);
  const [raw, setRaw] = useState(0);

  // AI-generated tests live in the profile, so resolve against both sources.
  const test = useMemo(() => {
    const id = params.get("id");
    return (
      bundled.find((t) => t.id === id) ??
      (profile.genTests.find((g) => g.kind === "reading" && g.test.id === id)?.test as
        | ReadingTest
        | undefined) ??
      null
    );
  }, [params, profile.genTests]);

  const submit = useCallback(() => {
    if (!test || submitted) return;
    const asked = flatQuestions(test.questions);
    let correct = 0;
    for (const q of asked) {
      if (isCorrect(q, answers[q.id])) correct++;
    }
    const b = rawToBand(correct, asked.length, "reading");
    setRaw(correct);
    setBand(b);
    setSubmitted(true);
    addResult({
      module: "reading",
      testId: test.id,
      testTitle: test.title,
      band: b,
      raw: correct,
      total: asked.length,
      date: new Date().toISOString(),
    });
  }, [test, answers, submitted]);

  // Generated tests are read from localStorage, so wait for hydration before
  // deciding a test is genuinely missing.
  if (!test) {
    if (!mounted) return null;
    return (
      <div className="card mx-auto mt-[10vh] max-w-xl text-center">
        <p className="text-slate-600">We couldn&apos;t find that test on this device.</p>
        <Link href="/practice" className="btn-primary mt-4">
          Back to practice tests
        </Link>
      </div>
    );
  }

  if (!started) {
    return (
      <div className="mx-auto flex min-h-[55vh] max-w-xl items-center">
        <div className="card w-full space-y-4 py-8 text-center">
          <h1 className="text-[26px] font-semibold text-slate-900">{test.title}</h1>
          <p className="text-sm text-slate-600">{test.topic}</p>
          <p className="text-sm text-slate-600">
            One academic passage, {questionCount(test.questions)} questions,{" "}
            {test.timeMinutes} minutes. Question types:{" "}
            {joinWithAnd(questionTypeNames(test.questions))} — exactly like the real exam.
          </p>
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            You can check any single answer as you go and read the explanation straight away.
            Checking locks that question, so your band stays honest.
          </p>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              How do you want to practise?
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {([
                {
                  id: "timed" as const,
                  title: "Exam conditions",
                  blurb: `${test.timeMinutes} minutes, clock running`,
                },
                {
                  id: "free" as const,
                  title: "No time limit",
                  blurb: "Take as long as you like",
                },
              ]).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setMode(option.id)}
                  className={`rounded-xl border px-4 py-3 text-left transition-all ${
                    mode === option.id
                      ? "border-indigo-500 bg-indigo-50"
                      : "border-slate-200 bg-surface hover:border-slate-300"
                  }`}
                >
                  <span className="block text-sm font-semibold text-slate-900">
                    {option.title}
                  </span>
                  <span className="block text-xs text-slate-500">{option.blurb}</span>
                </button>
              ))}
            </div>
          </div>
          <button className="btn-primary" onClick={() => setStarted(true)}>
            Start reading test
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-900">{test.title}</h1>
        {!submitted &&
          (mode === "timed" ? (
            <Timer minutes={test.timeMinutes} running onExpire={submit} />
          ) : (
            <span className="rounded-lg border border-slate-200 bg-surface px-3 py-1.5 text-sm text-slate-500">
              No time limit
            </span>
          ))}
      </div>

      {submitted && band !== null && (
        <div className="card flex flex-col items-center gap-4 py-6 sm:flex-row sm:justify-center sm:gap-10">
          <BandBadge band={band} caption={`${raw}/${questionCount(test.questions)} correct`} />
          <div className="max-w-md text-sm text-slate-600">
            <p>
              Estimated reading band <span className="font-semibold">{band}</span> ({raw} of{" "}
              {questionCount(test.questions)} correct, scaled to the official conversion table). Work
              through the review below before you start another test — that is where the marks
              come from.
            </p>
            <div className="mt-3 flex gap-2">
              <Link href="/practice" className="btn-secondary">
                More tests
              </Link>
              <Link href="/plan" className="btn-primary">
                Study plan
              </Link>
            </div>
          </div>
        </div>
      )}

      {submitted && band !== null && (
        <Review
          items={buildReview(test.questions, answers)}
          advice={testAdvice(
            "reading",
            test.questions,
            buildReview(test.questions, answers).map((i) => i.id),
            band,
          )}
          total={questionCount(test.questions)}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-[1.15fr_1fr]">
        <div className="card prose-reading max-h-[78vh] overflow-y-auto lg:sticky lg:top-24">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Passage
            </h2>
            <span className="text-xs text-slate-400">Select any word to look it up</span>
          </div>
          {test.passage.split(/\n\n+/).map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
        <div>
          <TestQuestions
            questions={test.questions}
            answers={answers}
            onAnswer={(id, v) => setAnswers((a) => ({ ...a, [id]: v }))}
            submitted={submitted}
            checked={checked}
            onCheck={(id) => setChecked((c) => ({ ...c, [id]: true }))}
            mode="practice"
          />
          {!submitted && (
            <button className="btn-primary mt-5 w-full" onClick={submit}>
              Submit answers
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ReadingTestPage() {
  return (
    <Suspense fallback={null}>
      <ReadingTestPageRunner />
    </Suspense>
  );
}
