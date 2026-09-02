import { isCorrect, rawToBand, roundToHalf } from "@/lib/band";
import { flatQuestions, toGroups } from "@/lib/questions";
import { LISTENING_TESTS, READING_TESTS } from "@/lib/tests";
import {
  MOCK_EXAM_KEY,
  readLearnerItem,
  removeLearnerItem,
  writeLearnerItem,
} from "@/lib/progress/storage";
import writingData from "@/data/writing-tasks.json";
import type {
  ListeningTest,
  QuestionGroup,
  QuestionSet,
  ReadingTest,
  TestQuestion,
  WritingTask,
  WritingTasksData,
} from "@/lib/types";

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
  /*
    The ten papers added alongside the CEFR levelling, classified by the same
    rule as the eleven above: which of the four IELTS listening contexts the
    script actually is, not how hard it is. A paper missing from this map can
    never appear in a sitting, which is why the test that guards it names the
    ids rather than counting them.
  */
  "listening-12": 1, // hiring a car, at a counter
  "listening-16": 1, // booking rooms for a party, by phone
  "listening-20": 1, // cancelling a gym membership, in person
  "listening-13": 2, // one speaker: lost property announcement
  "listening-17": 2, // one speaker: museum audio guide
  "listening-21": 2, // one speaker: farmers' market radio announcement
  "listening-14": 3, // four speakers planning a recycling project
  "listening-18": 3, // three speakers choosing a dissertation topic
  "listening-15": 4, // lecture: urban beekeeping
  "listening-19": 4, // lecture: the global coffee trade
  /*
    Ten more, spread deliberately rather than evenly: two Part 1s, three Part
    2s, three Part 3s and two Part 4s, which is what brings the four buckets
    closest to the same depth. A sitting draws one recording per part at
    random, so the thinnest bucket is the one that decides how often a learner
    meets a paper they have already sat, and Part 3 was the thinnest.
  */
  "listening-22": 1, // ordering a cake, at a counter
  "listening-23": 1, // reporting a leak to a letting agency, by phone
  "listening-24": 2, // one speaker: station announcement about a line closure
  "listening-25": 2, // one speaker: how a community repair café works
  "listening-26": 2, // one speaker: careers-fair talk on an apprenticeship
  "listening-27": 3, // three speakers reviewing a psychology pilot study
  "listening-28": 3, // three speakers on essay feedback and a reading list
  "listening-29": 3, // three speakers on usability testing a prototype
  "listening-30": 4, // lecture: the acoustics of concert halls
  "listening-31": 4, // lecture: why languages disappear
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
  /**
   * Listening and reading answers, by question id.
   *
   * `string | number` rather than string, and that is not tidiness. A
   * multiple-choice answer is the option's index, and `TestQuestions` renders
   * its radios controlled on `given === idx` — a strict comparison. Storing
   * "2" where the renderer expects 2 makes every multiple-choice question in
   * the sitting unclickable: the click registers, the answer is recorded, and
   * the radio never fills in. It marks correctly and looks broken, which is the
   * worst combination. Caught by driving the paper in a browser; nothing in the
   * type system or the tests would have said a word.
   */
  answers: Record<string, string | number>;
  /** Writing answers, by task id. */
  essays: Record<string, string>;
  /**
   * Listening sections whose audio has already been played, by index.
   *
   * The exam plays each recording once. This is what enforces it across a
   * reload — without it, refreshing the page is a replay button.
   */
  played: number[];
  /**
   * The speaking band, once the interview has been marked.
   *
   * Held here rather than in the results screen because the interview is over
   * by the time the results are drawn, and a band that only existed in a
   * component's state would be lost to the reload that a fourteen-minute
   * recording session makes quite likely.
   *
   * `null` after speaking has finished means it happened and could not be
   * marked. `undefined` means it has not happened yet, and the two must stay
   * distinguishable — one is an honest gap in the report, the other is an exam
   * that is not over.
   */
  speakingBand?: number | null;
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

/*
  ---------------------------------------------------------------------------
  Why every question in a sitting is renamed

  Each paper in this app numbers its own questions from scratch: reading-1 asks
  q1 to q13, and so does reading-7. On a practice page that is fine, because one
  paper is on screen. A sitting puts three of them together, and every id
  collides.

  What that does is not subtle, but it is silent. Answers are keyed by id, so
  answering question 1 of Passage 1 also answers question 1 of Passages 2 and 3.
  The palette shows them all as answered. `data-question-id` matches three
  elements, so the palette scrolls to whichever the browser found first. And
  the marking is nonsense — a paper filled in perfectly scored 2 out of 40 the
  first time this was run.

  So the sitting works with renamed copies: `reading-7:q1` is unambiguous, and
  every consumer downstream — the renderer, the navigation, the review, the
  marking — keeps working unchanged because an id is all any of them wanted.
  The originals are untouched; these are copies.
*/
function rename(testId: string, q: TestQuestion): TestQuestion {
  return { ...q, id: `${testId}:${q.id}` };
}

/** One paper's blocks, with its questions renamed for use inside a sitting. */
export function sittingGroups(testId: string, set: QuestionSet): QuestionGroup[] {
  return toGroups(set).map((group) => ({
    ...group,
    questions: group.questions.map((q) => rename(testId, q)),
  }));
}

/** Every listening question in the sitting, in the order they are numbered. */
export function listeningQuestions(paper: MockPaper): TestQuestion[] {
  return paper.listening.flatMap((id) => {
    const test = listeningPaper(id);
    return test ? flatQuestions(test.questions).map((q) => rename(id, q)) : [];
  });
}

/** Every reading question in the sitting, in the order they are numbered. */
export function readingQuestions(paper: MockPaper): TestQuestion[] {
  return paper.reading.flatMap((id) => {
    const test = readingPaper(id);
    return test ? flatQuestions(test.questions).map((q) => rename(id, q)) : [];
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
  answers: Record<string, string | number>,
): { listening: ModuleMark; reading: ModuleMark } {
  const score = (questions: TestQuestion[], module: "listening" | "reading") => {
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
 * Task 1 and Task 2 into one writing band.
 *
 * Task 2 counts double, which is the official weighting and not a rounding
 * detail: it is the difference between a candidate who wrote a strong essay and
 * a weak chart description scoring 6.5 rather than 6. An answer that was never
 * written scores nothing rather than being left out of the average, because a
 * blank Task 1 in the real exam costs the same.
 */
export function writingBand(task1: number | null, task2: number | null): number {
  return roundToHalf(((task1 ?? 0) + 2 * (task2 ?? 0)) / 3);
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

/*
  Imported rather than spelled here, where it used to live.

  Three separate things now have to be able to drop this key — "Clear all
  history", an accepted "clear this device", and signing out — and none of
  them can import this module: it pulls the whole exam content bundle (the
  question banks, lib/tests, data/writing-tasks.json) in behind it, and
  lib/store.ts, which needs it, is imported by nearly every page that touches
  progress. Keeping the literal at the storage layer they all already import
  means there is one of it rather than four, and a rename cannot leave a
  clearer quietly pointing at a key nothing writes any more.
*/
const KEY = MOCK_EXAM_KEY;

/*
  Exposed as an external store, the same way lib/store.ts exposes the profile.

  The alternative — read storage in an effect and setState — is what this was
  first, and it is wrong twice over. It renders the start screen for one frame
  before the sitting appears, which on a resumed exam is a heart-stopping
  flash of "Start the exam" over the paper you are two hours into. And it makes
  the stored session a copy that React owns rather than the thing itself, so a
  write from anywhere else does not repaint.
*/
let cache: MockSession | null | undefined;
const listeners = new Set<() => void>();

/*
  A clear can now come from outside this module — clearMockExamSession in
  lib/progress/storage.ts, called by the two clears and by signing out. Those
  callers cannot import this file (see the note on KEY above), so they remove
  the key and announce it; this is the other half, turning that announcement
  back into an invalidated cache and a repaint. Without it a learner who
  cleared while a sitting was open would still see the paper in this tab,
  which is exactly the state the clear was supposed to end.

  Attached once, on the first subscriber, so a server render and a module
  loaded purely for `composeMock` never touch `window`.
*/
let watchingStorage = false;

function watchExternalClears(): void {
  if (watchingStorage || typeof window === "undefined") return;
  watchingStorage = true;
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key !== null && event.key !== KEY) return;
    cache = undefined;
    for (const l of listeners) l();
  });
}

export function subscribeSession(onChange: () => void): () => void {
  watchExternalClears();
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Stable snapshot — the same object identity until something writes. */
export function sessionSnapshot(): MockSession | null {
  if (cache === undefined) cache = loadSession();
  return cache;
}

/**
 * There is no sitting on the server, and there cannot be — it lives in
 * sessionStorage. Answering null keeps the server and the first client render
 * identical, and `useMounted` is what defers the real answer to after
 * hydration.
 */
export function serverSessionSnapshot(): MockSession | null {
  return null;
}

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
  cache = session;
  writeLearnerItem(KEY, JSON.stringify(session));
  for (const l of listeners) l();
}

export function clearSession(): void {
  cache = null;
  removeLearnerItem(KEY);
  for (const l of listeners) l();
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

/**
 * Ends a sitting because the candidate left the exam page.
 *
 * ---------------------------------------------------------------------------
 * Why leaving ends it
 *
 * Until now it did not, and the owner found what that costs: start the mock,
 * tap the menu, read a grammar page, come back — and the sitting is still
 * there with the clock still running. Every one of the rules that make a mock
 * exam worth sitting is defeated by that. The reading hour is an hour plus
 * however long you spent elsewhere; a listening recording plays once but you
 * can look up the word you missed between questions; and the band at the end
 * describes a sitting nobody could repeat on the day.
 *
 * So the rule is the one the exam hall has: leave the room and the paper is
 * over. It is not a punishment — nothing is recorded and nothing is spent, so
 * a learner who leaves by accident has lost their answers and nothing else,
 * and can start again immediately.
 *
 * ---------------------------------------------------------------------------
 * What it deliberately does not end
 *
 * A reload, a phone locking, a background tab being reclaimed. Those are not
 * leaving — they are the ordinary accidents of using a browser for three
 * hours, and losing a sitting to one of them would be the worst thing this
 * feature could do to somebody. They are distinguished from leaving in
 * app/exam/page.tsx, and the distinction is a real one rather than a guess:
 * navigating inside the app unmounts the exam screen, and neither a reload nor
 * a lock does.
 *
 * The results screen is also not a sitting. Once the marks are in there is
 * nothing left to protect, so leaving that keeps it.
 */
export function abandonSession(): void {
  const current = sessionSnapshot();
  if (!current || current.stage === "results") return;
  clearSession();
}
