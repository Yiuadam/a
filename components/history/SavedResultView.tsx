import Link from "next/link";
import Review from "@/components/Review";
import { buildReview } from "@/lib/review";
import { questionCount } from "@/lib/questions";
import type { CriterionGrade, ModuleResult } from "@/lib/types";

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(date)
    : value;
}

function Criteria({ criteria }: { criteria: CriterionGrade[] }) {
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {criteria.map((criterion) => (
        <li key={criterion.name} className="rounded-[var(--radius-xl)] border border-slate-200 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <strong className="text-sm text-slate-900">{criterion.name}</strong>
            <span className="font-semibold tabular-nums text-slate-900">{criterion.band}</span>
          </div>
          <p className="mt-1 text-sm leading-6 text-slate-600">{criterion.comment}</p>
        </li>
      ))}
    </ul>
  );
}

function FeedbackLists({ strengths, improvements }: { strengths: string[]; improvements: string[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-emerald-700">✓ Strengths</h3>
        <ul className="mt-2 space-y-1 text-sm leading-6 text-slate-700">
          {strengths.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-indigo-700">→ Improve</h3>
        <ul className="mt-2 space-y-1 text-sm leading-6 text-slate-700">
          {improvements.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </div>
    </div>
  );
}

function ObjectiveReview({ result }: { result: ModuleResult }) {
  if (result.review?.kind !== "objective") return null;
  const review = result.review;
  const items = buildReview(review.questions, review.answers);
  return (
    <>
      <details className="card !p-4">
        <summary className="cursor-pointer text-sm font-semibold text-slate-900">
          {review.source.kind === "reading" ? "Original passage" : "Original transcript"}
        </summary>
        {review.source.kind === "reading" ? (
          <div className="prose-reading mt-4 whitespace-pre-line">{review.source.passage}</div>
        ) : (
          <div className="mt-4 space-y-2">
            {review.source.script.map((turn, index) => (
              <p key={index} className="text-sm leading-6 text-slate-700">
                <strong className="text-slate-900">{turn.speaker}:</strong> {turn.text}
              </p>
            ))}
          </div>
        )}
      </details>
      <Review items={items} advice={review.advice} total={questionCount(review.questions)} />
    </>
  );
}

function WritingReview({ result }: { result: ModuleResult }) {
  if (result.review?.kind !== "writing") return null;
  return (
    <div className="space-y-4">
      {result.review.attempts.map(({ task, response, grade }, index) => (
        <section key={`${task.id}-${index}`} className="card space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
              Task {task.task} · Band {grade.overallBand}
            </p>
            <h2 className="mt-1 text-base font-semibold text-slate-900">{task.title}</h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">{task.prompt}</p>
          </div>
          <Criteria criteria={grade.criteria} />
          <FeedbackLists strengths={grade.strengths} improvements={grade.improvements} />
          <details>
            <summary className="cursor-pointer text-sm font-semibold text-slate-900">Your original answer</summary>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-700">{response}</p>
          </details>
          {grade.rewrittenExcerpt ? (
            <div className="rounded-[var(--radius-xl)] bg-indigo-50/70 p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-indigo-700">Improved excerpt</h3>
              <p className="mt-1 text-sm leading-6 text-slate-700">{grade.rewrittenExcerpt}</p>
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}

function SpeakingReview({ result }: { result: ModuleResult }) {
  if (result.review?.kind !== "speaking") return null;
  const { grade, transcript } = result.review;
  return (
    <div className="space-y-4">
      <section className="card space-y-4">
        <Criteria criteria={grade.criteria} />
        <FeedbackLists strengths={grade.strengths} improvements={grade.improvements} />
        <div className="rounded-[var(--radius-xl)] bg-indigo-50/70 p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-indigo-700">A stronger answer</h3>
          <p className="mt-1 text-sm leading-6 text-slate-700">{grade.betterAnswerExample}</p>
        </div>
        <p className="text-sm leading-6 text-slate-600">
          <strong className="text-slate-900">Pronunciation:</strong> {grade.pronunciationNote}
        </p>
      </section>
      <details className="card !p-4">
        <summary className="cursor-pointer text-sm font-semibold text-slate-900">Original interview transcript</summary>
        <div className="mt-4 space-y-2">
          {transcript.map((turn, index) => (
            <p key={index} className="text-sm leading-6 text-slate-700">
              <strong className={turn.role === "examiner" ? "text-slate-900" : "text-indigo-700"}>
                {turn.role === "examiner" ? "Examiner" : "You"}:
              </strong>{" "}
              {turn.text}
            </p>
          ))}
        </div>
      </details>
    </div>
  );
}

export default function SavedResultView({
  result,
  backHref,
  backLabel = "Back",
}: {
  result: ModuleResult;
  backHref: string;
  backLabel?: string;
}) {
  return (
    <div className="space-y-4">
      <header className="card flex flex-wrap items-center justify-between gap-4 !p-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">Saved feedback</p>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">{result.testTitle}</h1>
          <p className="mt-1 text-sm capitalize text-slate-500">{dateLabel(result.date)} · {result.module}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-3xl font-semibold tabular-nums text-slate-900">{result.band}</span>
          <Link href={backHref} className="btn-secondary">{backLabel}</Link>
        </div>
      </header>

      {!result.review ? (
        <section className="card">
          <p className="text-sm leading-6 text-slate-600">
            This score was saved before detailed feedback history was added, so only the band remains.
          </p>
        </section>
      ) : result.review.kind === "objective" ? (
        <ObjectiveReview result={result} />
      ) : result.review.kind === "writing" ? (
        <WritingReview result={result} />
      ) : (
        <SpeakingReview result={result} />
      )}
    </div>
  );
}
