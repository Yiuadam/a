import { isCorrect, rawToBand, roundToHalf } from "@/lib/band";
import { flatQuestions } from "@/lib/questions";
import { LISTENING_TESTS, READING_TESTS } from "@/lib/tests";
import { readLearnerItem, removeLearnerItem, writeLearnerItem } from "@/lib/progress/storage";
import writingData from "@/data/writing-tasks.json";
import type { ListeningTest, ReadingTest, WritingTask, WritingTasksData } from "@/lib/types";

/*
  A whole IELTS sitting, assembled from the papers this app already has.

  ---------------------------------------------------------------------------
  Why this is not "practice with a longer clock"

  Practice and an exam are different activities and the app now says so. A
  practice session marks as you go, explains as it marks, replays the audio and
  lets you stop; it is a lesson. A sitting tells you nothing at all for two and
  three-quarter hours and then tells you everything at once; it is a
  measurement. Running the second through the first's machinery is how you get
  a mock exam that quietly grades easier than the real one — the audio you
  replayed, the answer you checked, the clock you paused.

  So the sitting owns its own state, and the one thing every screen inside it
  can read is this module. What it deliberately does *not* own is the marking
  rules: `isCorrect` and `rawToBand` are the same functions practice uses, so a
  band means the same thing on both sides of the app.

  ---------------------------------------------------------------------------
  The shape of the sitting

  Listening 30 minutes, Reading 60, Writing 60, then Speaking — in that order,
  because that is the order a candidate meets them on the day. One clock per
  module. A module that has been left cannot be re-entered, which is the rule
  that makes the reading clock mean something: without it, "60 minutes for
  reading" is 60 minutes plus however long you like once you have seen the
  writing tasks.
*/

export const MOCK_MODULES = ["listening", "reading", "writing", "speaking"] as const;
export type MockModule = (typeof MOCK_MODULES)[number];

/**
 * How long each module runs.
 *
 * Listening is 30 rather than 40: computer-delivered IELTS gives two minutes at
 * the end to check answers, not the ten minutes the paper test allows for
 * copying them onto an answer sheet. There is no answer sheet here either.
 *
 * Speaking is not on a clock at all — the examiner paces it, and the number is
 * what the shell prints so a candidate knows roughly what they are in for. The
 * runner never expires it.
 */
export const MODULE_MINUTES: Record<MockModule, number> = {
  listening: 30,
  reading: 60,
  writing: 60,
  speaking: 14,
};

export const MODULE_NAMES: Record<MockModule, string> = {
  listening: "Listening",
  reading: "Reading",
  writing: "Writing",
  speaking: "Speaking",
};

/*
  Which of the four listening parts each shipped recording can serve as.

  The exam's four parts are not four recordings of the same kind. Part 1 is a
  transactional conversation between two people; Part 2 is one person talking
  about something everyday; Part 3 is two to four people discussing academic
  work; Part 4 is a lecture. A "mock" that played four lectures would have the
  right number of questions and none of the exam's difficulty curve.

  Written out rather than guessed from the data. Speaker count separates 1 from
  2 and 3 from 4, but nothing in the JSON distinguishes a museum tour from a
  lecture, and inferring "academic" from the context sentence is the kind of
  rule that works on all eleven papers today and mis-files the twelfth.
  tests/mock-exam.test.mjs fails if a paper is added and not classified here.
*/
export const LISTENING_PART: Record<string, 1 | 2 | 3 | 4> = {
  "listening-1": 1, // booking a class, by phone
  "listening-3": 1, // renting an allotment, by phone
  "listening-7": 1, // joining a choir, by phone
  "listening-10": 1, // reporting a lost bag
  "listening-5": 2, // one speaker briefing new volunteers
  "listening-8": 2, // one speaker guiding a museum tour
  "listening-6": 3, // four speakers planning fieldwork
  "listening-9": 3, // three speakers planning a presentation
  "listening-2": 4, // lecture: the history of timekeeping
  "listening-4": 4, // lecture: what museums choose to keep
  "listening-11": 4, // lecture: how coral reefs recover
};

const WRITING_TASKS: WritingTask[] = (writingData as WritingTasksData).tasks;

/** The papers one sitting is made of, by id. */
export interface MockPaper {
  /** Four recordings, one per part, in part order. */
  listening: string[];
  /** Three passages, in the order they are numbered. */
  reading: string[];
  /** Task 1 then Task 2. */
  writing: [string, string];
}

export interface ModuleMark {
  band: number;
  raw?: number;
  total?: number;
}

export interface MockMarks {
  listening: ModuleMark;
  reading: ModuleMark;
  /** null when there was no marking available — see `unmarked` below. */
  writing: ModuleMark | null;
  speaking: ModuleMark | null;
  /**
   * The mean of the four module bands, to the nearest half.
   *
   * null rather than a number whenever any module is unmarked. An "overall
   * band" computed from two modules is not an overall band, and a learner
   * shown one would carry it away as though it were.
   */
  overall: number | null;
  /** Modules that could not be marked, for the results screen to name. */
  unmarked: MockModule[];
}

export interface MockSession {
  version: 1;
  id: string;
  startedAt: string;
  paper: MockPaper;
  /** Where the candidate is. "results" once the whole sitting is marked. */
  stage: MockModule | "results";
  /**
   * When the running module's clock runs out, as epoch milliseconds.
   *
   * Absolute rather than "minutes remaining" because that is what survives a
   * reload: a stored duration would restart the clock on every refresh, which
   * turns an accidental F5 into unlimited time.
   */
  deadline: number | null;
  /** Listening and reading answers, by question id. */
  answers: Record<string, string>;
  /** Writing answers, by task id. */
  essays: Record<string, string>;
  /**
   * Listening sections whose audio has already been played, by index.
   *
   * The exam plays each recording once. This is what enforces it across a
   * reload — without it, refreshing the page is a replay button.
   */
  played: number[];
  marks: MockMarks | null;
}

function pick<T>(from: T[], count: number): T[] {
  const shuffled = [...from].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function listeningFor(part: 1 | 2 | 3 | 4): ListeningTest[] {
  return LISTENING_TESTS.filter((t) => LISTENING_PART[t.id] === part);
}

/**
 * Choose the papers for one sitting: one recording per listening part, three
 * reading passages, one Task 1 and one Task 2.
 *
 * Random, and it stays random — the same learner sitting a second mock should
 * meet a different paper. What must not change is the paper *within* a sitting,
 * which is why the result is written into the session rather than recomputed.
 */
export function composeMock(): MockPaper {
  const listening = ([1, 2, 3, 4] as const).map((part) => {
    const options = listeningFor(part);
    return pick(options, 1)[0]?.id ?? LISTENING_TESTS[0].id;
  });

  /*
    Academic reading, and Academic Task 1, because that is what the rest of the
    app teaches. General Training is issue #14 and when it lands it selects
    here — one branch, not a second sitting.
  */
  const reading = pick(READING_TESTS, 3).map((t) => t.id);
  const task1 = pick(WRITING_TASKS.filter((t) => t.task === 1 && t.variant === "academic"), 1)[0];
  const task2 = pick(WRITING_TASKS.filter((t) => t.task === 2), 1)[0];

  return {
    listening,
    reading,
    writing: [task1.id, task2.id],
  };
}

export function readingPaper(id: string): ReadingTest | undefined {
  return READING_TESTS.find((t) => t.id === id);
}

export function listeningPaper(id: string): ListeningTest | undefined {
  return LISTENING_TESTS.find((t) => t.id === id);
}

export function writingTask(id: string): WritingTask | undefined {
  return WRITING_TASKS.find((t) => t.id === id);
}

/** Every listening question in the sitting, in the order they are numbered. */
export function listeningQuestions(paper: MockPaper) {
  return paper.listening.flatMap((id) => {
    const test = listeningPaper(id);
    return test ? flatQuestions(test.questions) : [];
  });
}

/** Every reading question in the sitting, in the order they are numbered. */
export function readingQuestions(paper: MockPaper) {
  return paper.reading.flatMap((id) => {
    const test = readingPaper(id);
    return test ? flatQuestions(test.questions) : [];
  });
}

/**
 * Mark the two objective papers.
 *
 * Straight off the conversion table with the real question count, which is the
 * point of a full-length sitting: on a ten-question section `rawToBand` has to
 * scale 7/10 up to 28/40, so one mistake moves the band by half a point or
 * more. Forty questions cost what forty questions cost.
 */
export function markObjective(
  paper: MockPaper,
  answers: Record<string, string>,
): { listening: ModuleMark; reading: ModuleMark } {
  const score = (questions: ReturnType<typeof listeningQuestions>, module: "listening" | "reading") => {
    let raw = 0;
    for (const q of questions) {
      if (isCorrect(q, answers[q.id])) raw++;
    }
    return { raw, total: questions.length, band: rawToBand(raw, questions.length, module) };
  };

  return {
    listening: score(listeningQuestions(paper), "listening"),
    reading: score(readingQuestions(paper), "reading"),
  };
}

/**
 * The four module bands and, when there are four of them, the overall.
 *
 * The official rule rounds the mean to the nearest whole or half band, with
 * .25 going up and .75 going up — which is exactly `roundToHalf`, already
 * written for the placement test and already tested.
 */
export function overallFrom(marks: Omit<MockMarks, "overall" | "unmarked">): MockMarks {
  const unmarked: MockModule[] = [];
  if (!marks.writing) unmarked.push("writing");
  if (!marks.speaking) unmarked.push("speaking");

  const bands = [
    marks.listening.band,
    marks.reading.band,
    marks.writing?.band,
    marks.speaking?.band,
  ].filter((b): b is number => typeof b === "number");
  const overall =
    unmarked.length === 0 && bands.length === 4
      ? roundToHalf(bands.reduce((sum, b) => sum + b, 0) / 4)
      : null;

  return { ...marks, overall, unmarked };
}

// ---------------------------------------------------------------------------
// Persistence
//
// sessionStorage, through the same door as every other piece of learner work
// (lib/progress/storage.ts explains why it is not localStorage). That gives the
// behaviour a sitting needs and no more: a reload keeps your place and your
// clock, and closing the tab ends the exam. Which is also what would happen if
// you walked out of one.
// ---------------------------------------------------------------------------

const KEY = "bandup-mock-exam-v1";

export function loadSession(): MockSession | null {
  const raw = readLearnerItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MockSession;
    /*
      A stored session from an older shape is discarded rather than repaired.
      Half-migrating a sitting would produce a paper whose questions no longer
      match the answers recorded against them, and the learner would be marked
      on it without ever being told.
    */
    if (parsed.version !== 1 || !parsed.paper) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(session: MockSession): void {
  writeLearnerItem(KEY, JSON.stringify(session));
}

export function clearSession(): void {
  removeLearnerItem(KEY);
}

export function newSession(): MockSession {
  return {
    version: 1,
    id: `mock-${Date.now().toString(36)}`,
    startedAt: new Date().toISOString(),
    paper: composeMock(),
    stage: "listening",
    deadline: null,
    answers: {},
    essays: {},
    played: [],
    marks: null,
  };
}
