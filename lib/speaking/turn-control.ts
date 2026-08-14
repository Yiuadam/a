export type SpeakingPart = 1 | 2 | 3;

export type TurnEndReason = "natural-pause" | "time-limit";

export interface TurnEvidence {
  part: SpeakingPart;
  elapsedSeconds: number;
  wordCount: number;
  speechDetected: boolean;
  silenceMilliseconds: number;
  /** True when words arrive while the candidate is still speaking. */
  liveTranscript: boolean;
}

interface TurnPolicy {
  earliestNaturalEnd: number;
  minimumWords: number;
  localNaturalEnd: number;
  naturalPauseMilliseconds: number;
  hardLimit: number;
}

/*
  The examiner keeps the interview moving, but does not guess at meaning.

  A language model in this loop would add network delay and could cut a learner
  off because it misunderstood an accent. Instead, these rules use the same
  evidence a human examiner can reliably use in the moment: the IELTS part,
  how long the candidate has spoken, how much language has been produced, and
  whether they have reached a real pause. The final hard limit is what allows a
  question to end even when the candidate speaks continuously.
*/
const POLICIES: Record<SpeakingPart, TurnPolicy> = {
  1: {
    earliestNaturalEnd: 12,
    minimumWords: 18,
    localNaturalEnd: 18,
    naturalPauseMilliseconds: 1_500,
    hardLimit: 40,
  },
  2: {
    earliestNaturalEnd: 105,
    minimumWords: 80,
    localNaturalEnd: 105,
    naturalPauseMilliseconds: 1_800,
    hardLimit: 120,
  },
  3: {
    earliestNaturalEnd: 28,
    minimumWords: 45,
    localNaturalEnd: 35,
    naturalPauseMilliseconds: 1_700,
    hardLimit: 75,
  },
};

export function countSpokenWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/u).length : 0;
}

/** Decide whether the examiner should keep listening or move on. */
export function decideTurnEnd(evidence: TurnEvidence): TurnEndReason | null {
  const policy = POLICIES[evidence.part];

  if (evidence.elapsedSeconds >= policy.hardLimit) return "time-limit";
  if (!evidence.speechDetected) return null;
  if (evidence.silenceMilliseconds < policy.naturalPauseMilliseconds) return null;

  const enoughLanguage = evidence.liveTranscript
    ? evidence.wordCount >= policy.minimumWords
    : evidence.elapsedSeconds >= policy.localNaturalEnd;

  if (evidence.elapsedSeconds >= policy.earliestNaturalEnd && enoughLanguage) {
    return "natural-pause";
  }

  return null;
}

const NATURAL_TRANSITIONS = [
  "Thank you. Let's continue.",
  "All right. Moving on.",
  "I see. Here's another question.",
  "Okay. Let's turn to the next point.",
  "Right. We'll continue.",
] as const;

const TIME_LIMIT_TRANSITIONS = [
  "Thank you. Let's move on.",
  "All right, we'll continue.",
  "Okay, let's move to the next question.",
  "Thank you. We'll leave that there and continue.",
] as const;

/** A neutral, varied bridge between answers, selected deterministically per turn. */
export function examinerTransition(
  finalQuestion: boolean,
  reason: TurnEndReason,
  turnIndex = 0,
): string {
  if (finalQuestion) return "Thank you. That is the end of the speaking test.";
  const transitions = reason === "time-limit" ? TIME_LIMIT_TRANSITIONS : NATURAL_TRANSITIONS;
  return transitions[Math.abs(turnIndex) % transitions.length];
}

export interface ExaminerQuestion {
  part: SpeakingPart;
  question: string;
}

export const SPEAKING_PART_INTRO: Record<SpeakingPart, string> = {
  1: "In Part 1, I'd like to ask you some questions about yourself.",
  2: "In Part 2, I'm going to give you a topic card. You have one minute to prepare, then talk for one to two minutes.",
  3: "In Part 3, we'll discuss some more general questions related to that topic.",
};

/** The exact spoken prompt for one question, including a part introduction. */
export function examinerQuestion(questions: ExaminerQuestion[], index: number): string {
  const current = questions[index];
  if (!current) return "";
  const startsPart = index === 0 || questions[index - 1]?.part !== current.part;
  return `${startsPart ? `${SPEAKING_PART_INTRO[current.part]} ` : ""}${current.question}`.trim();
}

/**
 * Transition and next question are one speech job. This lets the neural voice
 * prepare the question while the short acknowledgement is still playing.
 */
export function examinerFollowUp(
  questions: ExaminerQuestion[],
  currentIndex: number,
  reason: TurnEndReason,
): string {
  const nextIndex = currentIndex + 1;
  const finalQuestion = nextIndex >= questions.length;
  return [
    examinerTransition(finalQuestion, reason, currentIndex),
    finalQuestion ? "" : examinerQuestion(questions, nextIndex),
  ]
    .filter(Boolean)
    .join(" ");
}
