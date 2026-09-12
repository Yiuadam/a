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
  /**
   * How many times the examiner has already nudged this turn. Optional so
   * every existing caller — and every existing test — keeps compiling
   * unchanged; absent is the same as zero.
   */
  nudgesUsed?: number;
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

/*
  When to ask a live examiner for its reaction, rather than wait for it.

  Only Part 3 ever asks — see components/speaking/SpeakingSession.tsx — and it
  asks the moment there is enough answer to react to, not when the turn is
  about to end. That is the whole trick: a model call takes real time, and a
  Part 3 answer runs well past this point before decideTurnEnd can fire at
  all, so firing here spends that time hiding a network round trip inside
  dead air rather than adding a pause the exam clock never asked for.

  Below POLICIES[3].minimumWords (45) on purpose. Firing at the same
  threshold decideTurnEnd uses would mean the two can trip in the same tick —
  a candidate who reaches 45 words is also standing right at the
  earliestNaturalEnd/enoughLanguage line, and a turn that ends before this
  fetch has even started would leave nothing to hide the latency inside. This
  number only has to be "enough of an answer to react to sensibly", which is
  a lower bar than "enough of an answer to end the turn on".
*/
export const EXAMINER_LINE_TRIGGER_WORDS = 24;

/** Decide whether the examiner should keep listening or move on. */
export function decideTurnEnd(evidence: TurnEvidence): TurnEndReason | null {
  const policy = POLICIES[evidence.part];

  if (evidence.elapsedSeconds >= policy.hardLimit) return "time-limit";
  if (!evidence.speechDetected) return null;
  if (evidence.silenceMilliseconds < policy.naturalPauseMilliseconds) return null;

  // Once the examiner has already spoken up once this turn, a candidate who
  // reaches a real pause has answered the nudge, however short that answer
  // was — the same reason a human examiner does not keep waiting for a fixed
  // word count after asking "Why is that?" a second time.
  const enoughLanguage =
    (evidence.nudgesUsed ?? 0) > 0
      ? true
      : evidence.liveTranscript
        ? evidence.wordCount >= policy.minimumWords
        : evidence.elapsedSeconds >= policy.localNaturalEnd;

  if (evidence.elapsedSeconds >= policy.earliestNaturalEnd && enoughLanguage) {
    return "natural-pause";
  }

  return null;
}

/*
  The nudge exists because decideTurnEnd's only exit below minimumWords is the
  hard limit, and the hard limit is tens of seconds away — 40 / 120 / 75 s for
  Parts 1 / 2 / 3. A candidate who gives a short, complete answer and stops
  would otherwise sit in silence for most of that window before the examiner
  spoke again. A real examiner does not wait that long; they notice the pause
  and say something short. This is that something, timed to arrive well before
  the hard limit but only once the candidate has actually gone quiet.
*/
export type NudgeKind = "probe" | "silent";

/** How long a pause must run, once the candidate has spoken, before the examiner probes. */
export const NUDGE_SILENCE_MS: Record<SpeakingPart, number> = {
  1: 2_500,
  2: 4_000,
  3: 3_000,
};

/** How long a turn can sit with no speech at all before the examiner checks in. */
const SILENT_NUDGE_SECONDS = 8;

/**
 * Decide whether the examiner should speak up mid-turn. Distinct from
 * decideTurnEnd: this never ends the turn, and it fires at most once — a
 * caller that has already used its nudge (evidence.nudgesUsed > 0) never gets
 * a second one, so the interview cannot fall into repeatedly interrupting
 * someone who is genuinely still thinking.
 */
export function decideNudge(evidence: TurnEvidence): NudgeKind | null {
  const policy = POLICIES[evidence.part];
  if ((evidence.nudgesUsed ?? 0) > 0) return null;
  if (evidence.elapsedSeconds >= policy.hardLimit) return null;

  if (!evidence.speechDetected) {
    return evidence.elapsedSeconds >= SILENT_NUDGE_SECONDS ? "silent" : null;
  }

  // A candidate who has already said enough is left alone: decideTurnEnd
  // will close the turn on its own at the ordinary natural-pause threshold,
  // which is shorter than every part's nudge silence in this table.
  if (evidence.wordCount >= policy.minimumWords) return null;
  if (evidence.silenceMilliseconds < NUDGE_SILENCE_MS[evidence.part]) return null;
  return "probe";
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

// A real Part 3 probe is three or four words — "Why is that?", not a
// restatement of the question. Part 2 is mid-monologue, so its lines are
// permission to continue rather than a question at all. Each bank holds three
// so a candidate nudged more than once across an interview does not hear the
// same line twice; `index` picks among them the same way turnIndex does for
// examinerTransition above.
const PART1_PROBES = ["Why is that?", "Can you say more?", "What makes you say that?"] as const;
const PART2_PROBES = ["Please carry on.", "Take your time.", "Is there anything else?"] as const;
const PART3_PROBES = [
  "Why do you think that?",
  "Could you explain a little more?",
  "What makes you think so?",
] as const;

/*
  Exported so the audio catalogue can register one reviewed recording per probe
  rather than guessing how many there are. An id built on a bank length the
  catalogue assumed would silently stop resolving the day a fourth line is
  added here, and the nudge would drop to the device voice with nothing to say
  it had.
*/
export const PROBE_NUDGES: Record<SpeakingPart, readonly string[]> = {
  1: PART1_PROBES,
  2: PART2_PROBES,
  3: PART3_PROBES,
};

// Someone who has said nothing yet is not being asked to elaborate — they may
// not have realised the answer window opened. One calm, unvaried line offers
// the one thing that actually helps: hearing the question again.
const SILENT_NUDGE = "Take your time. Would you like me to repeat the question?";

/** The examiner's brief spoken interruption when a turn has gone quiet. */
export function examinerNudge(part: SpeakingPart, index: number, kind: NudgeKind = "probe"): string {
  if (kind === "silent") return SILENT_NUDGE;
  const bank = PROBE_NUDGES[part];
  return bank[Math.abs(index) % bank.length];
}
