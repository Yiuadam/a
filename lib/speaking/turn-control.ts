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

export function examinerTransition(finalQuestion: boolean, reason: TurnEndReason): string {
  if (finalQuestion) return "Thank you. That is the end of the speaking test.";
  return reason === "time-limit" ? "Thank you. Let's move on." : "All right, thank you.";
}
