/*
  How much of the test has actually been written.

  ---------------------------------------------------------------------------
  Why this is not a timer

  A bar that fills on a clock is a lie with a progress bar drawn on it. It
  reaches 90% and stops, or finishes while the work is still running, and after
  the second time a learner notices they stop believing any bar in the app. The
  owner asked for a real one, and the only honest source of "how far along" is
  what the model has actually produced.

  So the generation is streamed, and this reads the half-written JSON as it
  arrives. It never guesses and never advances on its own: if nothing new has
  been generated, the number does not move.

  ---------------------------------------------------------------------------
  Reading a document that is not valid yet

  The text arriving is a JSON document with its closing brace missing, and it
  cannot be parsed until the last token. So this counts rather than parses, and
  counts the one landmark that is unambiguous in a partial document: each
  question object carries `"explanation"`, exactly once, and it is the last
  field the model writes for that question. Counting completed explanations
  therefore counts *finished* questions rather than started ones — which is the
  number worth showing, because a question without its explanation is not a
  question this app will accept.

  The passage is measured the same way, by its own length against the length
  the prompt asked for. That is a real measurement of a real thing, and it is
  the reason the first half of the bar moves at all rather than sitting at zero
  for forty seconds.

  ---------------------------------------------------------------------------
  The one place it is deliberately not linear

  The bar stops at 99 until the response is complete. There is always work
  after the last explanation — closing the document, validating it, saving it —
  and a bar that sits at 100% while the button is still spinning is the same
  broken promise as one that fills on a timer.
*/

export type GeneratePhase = "starting" | "passage" | "questions" | "finishing" | "done";

export interface GenerateProgress {
  phase: GeneratePhase;
  /** 0–100. Never decreases, never reaches 100 before the work is finished. */
  percent: number;
  /** Questions whose explanation has been written. */
  questionsDone: number;
  questionsTotal: number;
  /** One short line for the learner, describing what is happening now. */
  label: string;
}

export interface ProgressShape {
  /** How many questions this kind of test has. */
  questions: number;
  /** Roughly how long the passage or script runs, in characters. */
  bodyChars: number;
  /** What the body is called, for the label: "passage", "script", "questions". */
  bodyLabel: string;
}

/*
  The share of the bar the body gets. Reading spends genuinely more of its
  output on the passage than listening does on its script, but not by enough to
  justify two numbers — and a number tuned per kind is a number that goes stale
  when a prompt changes. A third is close enough for both and wrong in a way
  nobody can see.
*/
const BODY_SHARE = 0.35;

/** The field every question ends with, and writes exactly once. */
const DONE_MARKER = /"explanation"\s*:/g;

/** Where the body text starts, for either kind of test. */
const BODY_START = /"(?:passage|script)"\s*:/;

function countMatches(text: string, pattern: RegExp): number {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let n = 0;
  while (re.exec(text) !== null) n += 1;
  return n;
}

/**
 * Reads progress out of however much JSON has arrived so far.
 *
 * Pure, and takes the accumulated text rather than a chunk, so it can be driven
 * from a test with a scripted stream and gives the same answer whatever the
 * chunk boundaries happened to be — which, over a network, they never are twice.
 */
export function readProgress(accumulated: string, shape: ProgressShape): GenerateProgress {
  const questionsDone = Math.min(countMatches(accumulated, DONE_MARKER), shape.questions);

  if (questionsDone > 0) {
    const share = questionsDone / shape.questions;
    const percent = Math.min(99, Math.round((BODY_SHARE + (1 - BODY_SHARE) * share) * 100));
    return {
      phase: questionsDone === shape.questions ? "finishing" : "questions",
      percent,
      questionsDone,
      questionsTotal: shape.questions,
      label:
        questionsDone === shape.questions
          ? "Checking the answer key"
          : `Writing question ${questionsDone + 1} of ${shape.questions}`,
    };
  }

  const bodyAt = accumulated.search(BODY_START);
  if (bodyAt === -1) {
    return {
      phase: "starting",
      percent: 1,
      questionsDone: 0,
      questionsTotal: shape.questions,
      label: "Choosing a topic",
    };
  }

  /*
    Measured from where the body actually begins, not from the start of the
    document — the fields before it are a fixed cost and counting them would
    put the bar at 8% before a word of the passage existed.
  */
  const written = accumulated.length - bodyAt;
  const share = Math.min(1, written / Math.max(1, shape.bodyChars));
  return {
    phase: "passage",
    percent: Math.max(2, Math.round(share * BODY_SHARE * 100)),
    questionsDone: 0,
    questionsTotal: shape.questions,
    label: `Writing the ${shape.bodyLabel}`,
  };
}

/** The shapes the generator can produce, and what each one is made of. */
export const SHAPES: Record<"reading" | "listening" | "speaking", ProgressShape> = {
  /* ~800 words at ~6 characters a word, which is what the prompt asks for. */
  reading: { questions: 13, bodyChars: 4800, bodyLabel: "passage" },
  listening: { questions: 10, bodyChars: 3600, bodyLabel: "script" },
  /* A speaking set has no body — it is questions all the way down. */
  speaking: { questions: 14, bodyChars: 1, bodyLabel: "questions" },
};

/**
 * Progress may only ever go forwards.
 *
 * The count itself cannot fall, but the two halves of the bar are computed
 * differently, and the moment the first explanation appears the formula
 * changes. Without this, a long passage could put the body phase above where
 * the first question lands and the bar would visibly step backwards — which
 * costs more trust than the extra precision was worth.
 */
export function monotonic(previous: number, next: number): number {
  return next > previous ? next : previous;
}
