"use client";

import { useCallback, useMemo, useState } from "react";
import ExplainText from "@/components/ExplainText";
import { type DrillQuestion, type DrillTopic, recordDrill, shuffle } from "@/lib/drills";

/**
 * One topic, practised one question at a time.
 *
 * This is study, not assessment, so it works the opposite way round from the
 * exam papers: you find out immediately whether you were right and read the
 * reason while the question is still in your head. There is no clock and no
 * band — the point is to leave knowing the rule, not to be measured against it.
 */
export default function Drill({ topic, onExit }: { topic: DrillTopic; onExit: () => void }) {
  // Shuffled once per mount, so a second run through a topic is a real re-test.
  const questions = useMemo(() => shuffle(topic.questions), [topic]);
  const [index, setIndex] = useState(0);
  const [choice, setChoice] = useState<number | undefined>(undefined);
  const [revealed, setRevealed] = useState(false);
  const [correct, setCorrect] = useState(0);
  const [missed, setMissed] = useState<DrillQuestion[]>([]);
  const [done, setDone] = useState(false);

  const question = questions[index];

  const check = useCallback(() => {
    if (choice === undefined || revealed) return;
    setRevealed(true);
    if (choice === question.answer) setCorrect((c) => c + 1);
    else setMissed((m) => [...m, question]);
  }, [choice, revealed, question]);

  const next = useCallback(() => {
    const isLast = index + 1 >= questions.length;
    if (isLast) {
      const finalCorrect = correct;
      recordDrill(topic.id, finalCorrect, questions.length);
      setDone(true);
      return;
    }
    setIndex((i) => i + 1);
    setChoice(undefined);
    setRevealed(false);
  }, [index, questions.length, correct, topic.id]);

  if (done) {
    const pct = Math.round((correct / questions.length) * 100);
    return (
      <div className="mx-auto max-w-2xl space-y-4" data-lookupable>
        <section className="card space-y-3 py-8 text-center">
          <h1 className="text-xl font-semibold text-slate-900">{topic.title}</h1>
          <p className="text-4xl font-bold text-indigo-600">
            {correct}/{questions.length}
          </p>
          <p className="text-sm text-slate-600">
            {pct === 100
              ? "Every one right. Try a harder topic, or come back to this one in a week to check it has stuck."
              : pct >= 75
                ? "Solid. Read the ones you missed below, then run the topic again — the questions come in a different order."
                : "Worth another go. Read the rule at the top of the topic again first; most of these come from one or two gaps, not from many."}
          </p>
          <div className="flex justify-center gap-2 pt-1">
            <button className="btn-secondary" onClick={onExit}>
              Back to topics
            </button>
            <button
              className="btn-primary"
              onClick={() => {
                setIndex(0);
                setChoice(undefined);
                setRevealed(false);
                setCorrect(0);
                setMissed([]);
                setDone(false);
              }}
            >
              Practise again
            </button>
          </div>
        </section>

        {missed.length > 0 && (
          <section className="card">
            <h2 className="text-sm font-semibold text-slate-900">What to look at again</h2>
            <ol className="mt-3 space-y-3">
              {missed.map((q) => (
                <li key={q.id} className="rounded-xl border border-slate-200 bg-surface p-4">
                  <p className="text-sm font-medium text-slate-900">{q.prompt}</p>
                  <p className="mt-2 text-sm text-emerald-700">
                    Answer: <span className="font-semibold">{q.options[q.answer]}</span>
                  </p>
                  <ExplainText
                    text={q.explanation}
                    className="mt-2 block text-sm leading-relaxed text-slate-600"
                  />
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4" data-lookupable>
      <div className="flex items-center justify-between">
        <button className="text-sm text-slate-500 hover:text-slate-800" onClick={onExit}>
          ← All topics
        </button>
        <span className="text-sm text-slate-500">
          {index + 1} of {questions.length} · {correct} right
        </span>
      </div>

      <div className="h-1.5 rounded-full bg-slate-100">
        <div
          className="h-1.5 rounded-full bg-indigo-500 transition-all"
          style={{ width: `${(index / questions.length) * 100}%` }}
        />
      </div>

      <div className="card">
        <p className="mb-4 whitespace-pre-line text-base font-medium text-slate-900">
          {question.prompt}
        </p>
        <div className="space-y-2">
          {question.options.map((opt, idx) => {
            const isAnswer = idx === question.answer;
            const picked = choice === idx;
            const tone = !revealed
              ? picked
                ? "border-indigo-500 bg-indigo-50"
                : "border-slate-200 bg-surface hover:bg-slate-50"
              : isAnswer
                ? "border-emerald-300 bg-emerald-50"
                : picked
                  ? "border-rose-300 bg-rose-50"
                  : "border-slate-200 bg-surface opacity-60";
            return (
              <label
                key={idx}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${tone}`}
              >
                <input
                  type="radio"
                  name={question.id}
                  checked={picked}
                  disabled={revealed}
                  onChange={() => setChoice(idx)}
                  className="accent-indigo-600"
                />
                <span className="text-slate-700">{opt}</span>
                {revealed && isAnswer && <span className="ml-auto text-emerald-600">✓</span>}
              </label>
            );
          })}
        </div>

        {revealed && (
          <div className="mt-4 border-t border-slate-200 pt-3">
            <p
              className={`text-sm font-medium ${
                choice === question.answer ? "text-emerald-700" : "text-rose-700"
              }`}
            >
              {choice === question.answer ? "✓ Correct" : "✗ Not quite"}
            </p>
            <ExplainText
              text={question.explanation}
              className="mt-1 block text-sm leading-relaxed text-slate-600"
            />
          </div>
        )}
      </div>

      <div className="flex justify-end">
        {revealed ? (
          <button className="btn-primary" onClick={next}>
            {index + 1 >= questions.length ? "See how I did" : "Next question"}
          </button>
        ) : (
          <button className="btn-primary" disabled={choice === undefined} onClick={check}>
            Check answer
          </button>
        )}
      </div>
    </div>
  );
}
