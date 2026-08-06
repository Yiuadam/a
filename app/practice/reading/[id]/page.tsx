"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import BandBadge from "@/components/BandBadge";
import TestQuestions, { type AnswerMap } from "@/components/TestQuestions";
import Timer from "@/components/Timer";
import readingOne from "@/data/reading-1.json";
import readingTwo from "@/data/reading-2.json";
import { isCorrect, rawToBand } from "@/lib/band";
import { useMounted, useProfile } from "@/lib/hooks";
import { addResult } from "@/lib/store";
import type { ReadingTest } from "@/lib/types";

const bundled = [readingOne, readingTwo] as ReadingTest[];

export default function ReadingTestPage() {
  const params = useParams<{ id: string }>();
  const profile = useProfile();
  const mounted = useMounted();
  const [started, setStarted] = useState(false);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [submitted, setSubmitted] = useState(false);
  const [band, setBand] = useState<number | null>(null);
  const [raw, setRaw] = useState(0);

  // AI-generated tests live in the profile, so resolve against both sources.
  const test = useMemo(() => {
    const id = params.id;
    return (
      bundled.find((t) => t.id === id) ??
      (profile.genTests.find((g) => g.kind === "reading" && g.test.id === id)?.test as
        | ReadingTest
        | undefined) ??
      null
    );
  }, [params.id, profile.genTests]);

  const submit = useCallback(() => {
    if (!test || submitted) return;
    let correct = 0;
    for (const q of test.questions) {
      if (isCorrect(q, answers[q.id])) correct++;
    }
    const b = rawToBand(correct, test.questions.length, "reading");
    setRaw(correct);
    setBand(b);
    setSubmitted(true);
    addResult({
      module: "reading",
      testId: test.id,
      testTitle: test.title,
      band: b,
      raw: correct,
      total: test.questions.length,
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
            One academic passage, {test.questions.length} questions,{" "}
            {test.timeMinutes} minutes. Question types: True/False/Not Given, multiple choice,
            and sentence completion — exactly like the real exam.
          </p>
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
        {!submitted && <Timer minutes={test.timeMinutes} running onExpire={submit} />}
      </div>

      {submitted && band !== null && (
        <div className="card flex flex-col items-center gap-4 py-6 sm:flex-row sm:justify-center sm:gap-10">
          <BandBadge band={band} caption={`${raw}/${test.questions.length} correct`} />
          <div className="max-w-md text-sm text-slate-600">
            <p>
              Estimated reading band <span className="font-semibold">{band}</span> ({raw} of{" "}
              {test.questions.length} correct, scaled to the official conversion table). Review
              the marked answers below, then head back for another test.
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

      <div className="grid gap-6 lg:grid-cols-[1.15fr_1fr]">
        <div className="card prose-reading max-h-[78vh] overflow-y-auto lg:sticky lg:top-24">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Passage
          </h2>
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
