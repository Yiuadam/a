"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useState } from "react";
import BandBadge from "@/components/BandBadge";
import DashboardVisit from "@/components/DashboardVisit";
import ScoreFooter from "@/components/ScoreFooter";
import PracticeLoading from "@/components/PracticeLoading";
import Review from "@/components/Review";
import TestQuestions, {
  type AnswerMap,
  type CheckedMap,
} from "@/components/TestQuestions";
import ExamShell from "@/components/exam/ExamShell";
import SplitPanes, { useIsWide } from "@/components/exam/SplitPanes";
import SwipePanels from "@/components/exam/SwipePanels";
import { useExamNavigation } from "@/lib/exam/navigation";
import { testAdvice } from "@/lib/advice";
import { isCorrect, rawToBand } from "@/lib/band";
import { useMounted, useProfile } from "@/lib/hooks";
import { flatQuestions, questionCount } from "@/lib/questions";
import { buildReview, joinWithAnd, questionTypeNames } from "@/lib/review";
import { savedAnswers } from "@/lib/results";
import { addResult } from "@/lib/store";
import { READING_TESTS } from "@/lib/tests";
import type { ReadingTest } from "@/lib/types";
import TestChooser from "@/components/TestChooser";
import AssignedPracticeNotice from "@/components/organization/AssignedPracticeNotice";

const bundled = READING_TESTS;

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

  /*
    The palette's view of the paper: every question in the order the exam
    numbers them, and whether anything has been put against it.

    Above every early return, because these are hooks and `test` can be null —
    a paper id that matches nothing renders a "not found" screen, and hooks
    that ran only on the other branch would change order between renders.
    `flatQuestions` is given an empty set in that case and answers nothing.
  */
  const flat = useMemo(() => (test ? flatQuestions(test.questions) : []), [test]);
  const nav = useExamNavigation(
    useMemo(
      () => flat.map((q) => ({ id: q.id, answered: answers[q.id] !== undefined })),
      [flat, answers],
    ),
  );
  const wide = useIsWide();

  const submit = useCallback(() => {
    if (!test || submitted) return;
    const asked = flatQuestions(test.questions);
    let correct = 0;
    for (const q of asked) {
      if (isCorrect(q, answers[q.id])) correct++;
    }
    const b = rawToBand(correct, asked.length, "reading");
    const reviewItems = buildReview(test.questions, answers);
    const advice = testAdvice(
      "reading",
      test.questions,
      reviewItems.map((item) => item.id),
      b,
    );
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
      review: {
        kind: "objective",
        questions: test.questions,
        answers: savedAnswers(answers),
        advice,
        source: { kind: "reading", passage: test.passage },
      },
    });
  }, [test, answers, submitted]);

  // Generated tests are read from localStorage, so wait for hydration before
  // deciding a test is genuinely missing.
  /*
    No id in the URL is not an error — it is the header's "Reading" link,
    which is how most people arrive. It used to answer "we couldn't find that
    test on this device", which is a dead end wearing an error message: a
    learner who clicked Reading gets told something is missing and is sent
    to a page listing all four skills.

    So it lists the reading papers, and only those. An id that genuinely does
    not resolve — a stale bookmark, a generated test cleared from this browser
    — still says so, because that one is a real miss.
  */
  if (!test) {
    if (!mounted) return null;
    const asked = params.get("id");
    return (
      <TestChooser
        kind="reading"
        tests={bundled}
        missingId={asked}
      />
    );
  }

  if (!started) {
    return (
      <div className="mx-auto flex min-h-[calc(100dvh-3.75rem)] max-w-xl items-center px-4">
        <div className="card w-full space-y-4 py-8 text-center">
          <AssignedPracticeNotice />
          <h1 className="text-[26px] font-semibold text-slate-900">{test.title}</h1>
          <p className="text-sm text-slate-600">{test.topic}</p>
          <p className="text-sm text-slate-600">
            One passage to read, {questionCount(test.questions)} questions,{" "}
            {test.timeMinutes} minutes. You will answer these kinds of question:{" "}
            {joinWithAnd(questionTypeNames(test.questions))}. The real exam uses the same kinds.
          </p>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              How do you want to do this test?
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {([
                {
                  id: "timed" as const,
                  title: "Like the real exam",
                  blurb: `${test.timeMinutes} minutes. You cannot check answers`,
                },
                {
                  id: "free" as const,
                  title: "Practise slowly",
                  blurb: "No clock. Check answers as you go"
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
            {/*
              Under the choice, not above it, and describing the option that is
              actually selected. It used to sit above and describe checking as
              though it applied to both — next to a button labelled "Exam
              conditions", which is where the contradiction came from.
            */}
            <p className="text-inset-compact mt-2 rounded-lg bg-indigo-50 py-2 text-left text-sm leading-6 text-indigo-800">
              {mode === "timed"
                ? "Like the real exam: you cannot see any answers until you finish. When you finish, you get your band and every explanation."
                : "You can check one answer at a time and read why it is right. Once you check a question you cannot change it, so your band still means something."}
            </p>
          </div>
          <button className="btn-primary" onClick={() => setStarted(true)}>
            Start reading test
          </button>
        </div>
      </div>
    );
  }

  const passage = (
    <>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--exam-muted)]">
          Passage
        </h2>
        <span className="text-[11px] text-[color:var(--exam-muted)]">
          Select any word to look it up
        </span>
      </div>
      {test.passage.split(/\n\n+/).map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </>
  );

  const questions = (
    <>
      <TestQuestions
        questions={test.questions}
        answers={answers}
        onAnswer={(id, v) => setAnswers((a) => ({ ...a, [id]: v }))}
        submitted={submitted}
        checked={checked}
        onCheck={(id) => setChecked((c) => ({ ...c, [id]: true }))}
        mode={mode === "timed" ? "exam" : "practice"}
      />
      {!submitted && (
        <button className="btn-primary mt-5 w-full" onClick={submit}>
          Submit answers
        </button>
      )}
    </>
  );

  return (
    <div className={`space-y-4 ${submitted ? "practice-result-page" : ""}`}>
      {submitted && band !== null && (
        <div className="card flex flex-col items-center gap-4 py-6 sm:flex-row sm:justify-center sm:gap-10">
          <BandBadge band={band} caption={`${raw}/${questionCount(test.questions)} correct`} />
          <div className="max-w-md text-sm text-slate-600">
            <p>
              Estimated reading band <span className="font-semibold">{band}</span> ({raw} of{" "}
              {questionCount(test.questions)} correct, scaled using the published conversion table). Work
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

      {/*
        The paper itself, inside the exam's own furniture.

        Everything from here down is the computer-delivered IELTS screen rather
        than a web page about it: the clock top-centre, Settings top-right, the
        forty numbers along the bottom with the square-to-circle review flag,
        and the passage and questions side by side with a bar you can drag.
        components/exam/ExamShell.tsx has the reasoning for each.

        Below `lg` the split becomes the horizontal swipe track it already was,
        because the real exam never has to answer for a 390px screen and this
        app does. Stacked, a reading paper is unusable on a phone: the passage
        is 800 words, so answering question 7 means scrolling up past all of it
        and back down to find your place. As a snap track each half keeps its
        own scroll position for free, and swiping back finds the passage exactly
        where it was left.
      */}
      <ExamShell
        section="Reading"
        paper={test.title}
        minutes={test.timeMinutes}
        running={mode === "timed" && !submitted}
        onExpire={submit}
        palette={submitted ? [] : nav.items}
        currentId={nav.currentId}
        onJump={nav.jump}
        onPrev={nav.prev}
        onNext={nav.next}
        onToggleReview={nav.toggleReview}
        onNextFlagged={nav.nextFlagged}
        bottomLeft={
          submitted ? `${raw} of ${questionCount(test.questions)} correct` : "No time limit"
        }
      >
        {wide ? (
          <SplitPanes
            className="h-full"
            left={<div className="prose-reading">{passage}</div>}
            right={questions}
          />
        ) : (
          <SwipePanels
            panels={[
              { label: "Passage", content: <div className="prose-reading">{passage}</div> },
              { label: "Questions", content: questions },
            ]}
          />
        )}
      </ExamShell>

      {/*
        The score again, where the learner actually is when the paper is
        marked. The card at the top of the page heads the review; this closes
        the paper. See components/ScoreFooter.tsx.
      */}
      {submitted && band !== null && (
        <ScoreFooter
          module="reading"
          band={band}
          raw={raw}
          total={questionCount(test.questions)}
        />
      )}
    </div>
  );
}

export default function ReadingTestPage() {
  return (
    <>
      <DashboardVisit destination="reading" />
      <Suspense fallback={<PracticeLoading kind="Reading" />}>
        <ReadingTestPageRunner />
      </Suspense>
    </>
  );
}
