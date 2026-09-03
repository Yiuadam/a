import { marksEarned, rawToBand, roundToHalf } from "@/lib/band";
import { flatQuestions, questionCount, toGroups } from "@/lib/questions";
import { LISTENING_TESTS, READING_TESTS } from "@/lib/tests";
import {
  MOCK_EXAM_KEY,
  readLearnerItem,
  removeLearnerItem,
  writeLearnerItem,
} from "@/lib/progress/storage";
import { REPORT_MODULES, overallBand } from "@/lib/exam/report";
import { addMockRetake } from "@/lib/store";
import writingData from "@/data/writing-tasks.json";
import type {
  ListeningTest,
  MockRetake,
  QuestionGroup,
  QuestionSet,
  ReadingTest,
  SpeakingGrade,
  SpeakingTranscriptTurn,
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

  ---------------------------------------------------------------------------
  A sitting is not always all four

  Two different things produce a sitting of one module rather than four, and
  they share this file's machinery because they are the same paper, the same
  clock and the same silence until the end — they differ only in what happens
  once the band exists. A One Skill Retake replaces one line of an earlier
  report. A standalone single-skill exam has no earlier report to update and
  simply records its own band, the way a full sitting would for that module
  alone, if the other three had never been sat.

  `MockSession.retake` below is what makes a session either of these rather
  than a full one — `of` present for a retake, absent for a standalone sitting
  — and `sittingModules` is the single answer to "which modules is this?" that
  everything downstream asks. What each kind changes, and what it deliberately
  does not, is written up in lib/exam/report.ts for the retake and at the top
  of components/exam/MockSkillResults.tsx for the standalone sitting.
*/

/*
  Re-exported rather than declared, so the order lives in exactly one place.
  It moved to lib/exam/report.ts because the history page needs it and must not
  import this module to get it: everything below pulls in every reading passage
  and listening script the app ships, and history has no use for any of them.
*/
export const MOCK_MODULES = REPORT_MODULES;
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

/**
 * What makes a session cover one module rather than all four.
 *
 * `of` names the `MockExamReport` this session updates once it is marked,
 * which is the real rule as well: a retake is booked against a specific test
 * and updates that test's report, not "your score" in the abstract. Recording
 * it means the band can be attached to the right sitting even if the learner
 * sits another full mock in between.
 *
 * `of` is absent for a standalone single-skill exam — the same one module,
 * the same paper, the same clock, sat with no earlier sitting behind it and
 * therefore nothing for a band to update. That is not a lesser kind of
 * retake; it is the other reason a sitting can be one module rather than
 * four, and the two are kept as one struct rather than two so that
 * `sittingModules`, `nextStage` and the rest of this file cannot drift out of
 * step for one of them while staying in step for the other. What tells them
 * apart downstream is exactly this field: present,
 * components/exam/MockRetakeResults.tsx marks the module and writes the band
 * over an existing report; absent, components/exam/MockSkillResults.tsx marks
 * it and writes an ordinary result with no report involved at all.
 */
export interface MockRetakeIntent {
  /** The `MockExamReport.id` this session updates, or absent for a standalone sitting. */
  of?: string;
  module: MockModule;
}

export interface MockSession {
  /**
   * Still 1, and that is a decision rather than an oversight.
   *
   * `loadSession` throws away a session whose version it does not recognise,
   * because a half-migrated sitting would mark a candidate against a paper that
   * is no longer the one they answered. That rule is right, and it is exactly
   * why the retake had to arrive as an *optional* field: bumping this to 2
   * would have destroyed every sitting in progress on the deploy that shipped
   * it, and somebody is two hours into one. A stored session with no `retake`
   * key reads back as a full sitting, which is what it is.
   */
  version: 1;
  id: string;
  startedAt: string;
  paper: MockPaper;
  /**
   * Absent for a full sitting. Present for a sitting of one module — a One
   * Skill Retake when `retake.of` names the report it updates, or a
   * standalone single-skill exam when it does not. See `MockRetakeIntent`.
   */
  retake?: MockRetakeIntent;
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
  /**
   * Everything else the speaking examiner said, when it said it.
   *
   * The band above is not what the examiner produced; it is the one number
   * salvaged from it. `SpeakingGrade` also carries the four criteria with a
   * comment each, the strengths, the improvements, a better-answer example and
   * a note on pronunciation — all of it generated, all of it shown once on the
   * interview screen, and all of it previously dropped on the floor the moment
   * the sitting moved on. The results screen can now report Writing in full,
   * and Speaking being a bare number beside it is not a difference in what the
   * two modules measure, only in what this session bothered to keep.
   *
   * Same three-state rule as `speakingBand`, and it has to be: `undefined`
   * means the interview has not happened, or happened under a build that did
   * not keep this; `null` means it happened and could not be marked. The band
   * stays the authority on what the module scored — a session stored before
   * this field existed has one and no grade, and reading the band off
   * `speakingGrade.overallBand` instead would mark that sitting as unmarked.
   */
  speakingGrade?: SpeakingGrade | null;
  /**
   * The interview itself, written down.
   *
   * Kept for the same reason the standalone speaking test already keeps one
   * (components/speaking/SpeakingSession.tsx saves a `SpeakingResultReview`
   * with the transcript in it): feedback on how somebody spoke is close to
   * useless without the words it is about, and a learner reopening a sitting a
   * week later cannot remember what they said.
   *
   * A transcript is the most personal thing this app holds, so it is worth
   * being exact about what this line does and does not do. It lives in the
   * session, which is sessionStorage: per-tab, gone when the tab closes, and
   * taken by a sign-out and by either clear along with the rest of the
   * sitting. It is never uploaded from here. What outlives the tab is only
   * what the results screen chooses to save into `ModuleResult.review`, which
   * is exactly the record standalone speaking already writes and which
   * app/privacy/page.tsx describes. The tutor reads saved results rather than
   * this field, so an exam interview becomes readable to it on the same terms
   * as a practice one and on no other terms.
   *
   * That used to be gated by a switch in lib/tutor/consent.ts. There is no
   * switch now — the tutor reads saved speaking automatically, and clearing
   * history is what withholds it.
   */
  speakingTranscript?: SpeakingTranscriptTurn[];
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
  /*
    Thirteen, thirteen, fourteen — the real Academic paper's split, and the only
    way three passages come to forty.

    It is not a rounding convenience. Every paper in the bank was uniform at
    thirteen once, and when a fourteenth question was added to all of them the
    sitting quietly became a 42-question exam that announced itself as one on
    the start screen. A candidate's raw score is read against a 40-mark table,
    so the length of the paper is not a presentation detail: it decides the
    band. Two papers are drawn from the thirteens and one from the fourteens,
    and the long one is placed last, where the exam puts it.
  */
  const readingCount = (test: ReadingTest) => questionCount(flatQuestions(test.questions));
  const shortPapers = READING_TESTS.filter((t) => readingCount(t) === 13);
  const longPapers = READING_TESTS.filter((t) => readingCount(t) === 14);
  const reading = [...pick(shortPapers, 2), ...pick(longPapers, 1)].map((t) => t.id);
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
  /*
    Marks, not questions answered — and the two stopped being the same number
    the day multi-select arrived.

    "Choose TWO letters" is one entry in the JSON and two marks on the paper: it
    claims two of the forty numbers, and a candidate who gets one letter right
    earns one of them. Counting `isCorrect` per object would have scored that
    group out of one and left the sitting's denominator short by a mark for
    every multi-select in it — so a perfect paper would have read 38 of 38 while
    the real one is 40 of 40, and every band derived from it would have been
    computed against the wrong total.

    `marksEarned` is the generalisation: 0 or 1 for every other type, 0 to
    `numAnswers` for this one. `questionCount` sums the same widths, so the two
    halves of the fraction are measured the same way.
  */
  const score = (questions: TestQuestion[], module: "listening" | "reading") => {
    let raw = 0;
    for (const q of questions) raw += marksEarned(q, answers[q.id]);
    const total = questionCount(questions);
    return { raw, total, band: rawToBand(raw, total, module) };
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
 *
 * The arithmetic itself is `overallBand` in lib/exam/report.ts, called rather
 * than repeated. There are now two ways to arrive at four module bands — one
 * sitting, or a sitting updated by a retake — and the rule that withholds the
 * overall unless all four are marked has to be identical for both, or a learner
 * could be handed a number by one route that the other would have refused.
 */
export function overallFrom(marks: Omit<MockMarks, "overall" | "unmarked">): MockMarks {
  const unmarked: MockModule[] = [];
  if (!marks.writing) unmarked.push("writing");
  if (!marks.speaking) unmarked.push("speaking");

  const overall = overallBand({
    listening: marks.listening?.band,
    reading: marks.reading?.band,
    writing: marks.writing?.band,
    speaking: marks.speaking?.band,
  });

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
 * The session both a retake and a standalone single-skill exam build: one
 * module, sat on its own, everything else about the sitting held in common.
 *
 * The paper is composed in full even though only one module of it will ever be
 * opened. That looks wasteful and is the safe choice — `MockPaper` promises
 * three passages and four recordings to everything downstream, and a session
 * that shipped a half-empty paper would put an "or undefined" into every
 * consumer for the sake of saving nothing at all. The unused papers are three
 * strings; the stage machinery below is what guarantees they are never shown.
 *
 * `idPrefix` is the only reason this is not simply `newRetakeSession` with an
 * optional `of` parameter. Both ids end up in a `ModuleResult.testId`, and
 * "which of these rows came from a retake and which from a standalone
 * sitting" is a question the archive should be able to answer without a join.
 */
function newSoloSession(idPrefix: string, retake: MockRetakeIntent): MockSession {
  return {
    version: 1,
    id: `${idPrefix}-${Date.now().toString(36)}`,
    startedAt: new Date().toISOString(),
    paper: composeMock(),
    retake,
    stage: retake.module,
    deadline: null,
    answers: {},
    essays: {},
    played: [],
    marks: null,
  };
}

/** A One Skill Retake: one module, sat on its own, against an earlier sitting. */
export function newRetakeSession(module: MockModule, of: string): MockSession {
  return newSoloSession("retake", { of, module });
}

/**
 * A standalone single-skill exam: the complete paper for one module, at its
 * real timing, sat with no earlier sitting behind it.
 *
 * Built on exactly the same session a retake is — see `newSoloSession` —
 * because it is the same activity in every way that matters: one clock, one
 * paper, silence until the end. The only difference is `of`, left unset,
 * which is what tells components/exam/MockSkillResults.tsx there is no report
 * to update, only an ordinary result to record.
 */
export function newSingleSkillSession(module: MockModule): MockSession {
  return newSoloSession("solo", { module });
}

/**
 * Which modules this session covers: all four, or the one module a retake or
 * a standalone single-skill exam is sitting on its own.
 *
 * The single place that question is answered. Everything that walks a sitting —
 * choosing the next stage, deciding what to mark, deciding what to record —
 * asks here rather than testing `session.retake` for itself, because the
 * dangerous version of this bug is silent: a marker that assumed four modules
 * would score a retake's untouched Reading paper as forty wrong answers and
 * write a band 2 into the learner's history, and the screen would look right
 * while it did it.
 */
export function sittingModules(session: MockSession): readonly MockModule[] {
  return session.retake ? [session.retake.module] : MOCK_MODULES;
}

/**
 * Where a session goes when a module finishes: the next one it covers, or the
 * results. For a retake there is never a next one.
 */
export function nextStage(session: MockSession, from: MockModule): MockModule | "results" {
  const modules = sittingModules(session);
  const index = modules.indexOf(from);
  return (index >= 0 ? modules[index + 1] : undefined) ?? "results";
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
 *
 * ---------------------------------------------------------------------------
 * A retake abandoned halfway
 *
 * Exactly the same rule, and it needs no exception because of where the
 * recording happens. A retake writes nothing anywhere until it has been marked
 * and `recordRetake` below is called from the results screen; until then it is
 * a session and nothing else. So walking out of a retake ends it, the standing
 * report is untouched, and the module keeps whatever band it had — which is the
 * direction this has to fail in. The opposite arrangement, where a retake
 * staked a claim on the module the moment it began, would let a learner lower
 * their own recorded band by tapping the wrong thing and closing the tab.
 *
 * A standalone single-skill exam follows the same rule for a slightly simpler
 * reason: there was never a report for it to leave untouched, only the
 * ordinary `ModuleResult` that components/exam/MockSkillResults.tsx writes
 * once marking finishes. Leaving early means that write never happens, so
 * nothing is recorded at all — not a low band, not a gap where one used to
 * be, simply nothing, exactly as if the sitting had never been started.
 */
export function abandonSession(): void {
  const current = sessionSnapshot();
  if (!current || current.stage === "results") return;
  clearSession();
}

// ---------------------------------------------------------------------------
// Recording a finished retake
//
// The seam between a One Skill Retake and the learner's permanent archive. It
// lives here rather than in the screen that draws the result, because "what a
// finished sitting leaves behind" is a property of the exam model.
//
// There is deliberately no matching recordSitting for a full mock, and no
// version of this function for a standalone single-skill exam either. A full
// sitting is recorded by components/exam/MockResults.tsx calling addMockReport,
// and a standalone sitting by components/exam/MockSkillResults.tsx calling the
// ordinary addResult — neither can reach this function's screen, because
// app/exam/page.tsx routes a session by what `retake` contains: no `retake` at
// all goes to MockResults, `retake.of` present goes to MockRetakeResults,
// `retake.of` absent goes to MockSkillResults. That is the stronger guard
// anyway — it stops a sitting being *marked* as the wrong shape, not merely
// recorded as one.
// ---------------------------------------------------------------------------

/**
 * Records a completed One Skill Retake against the sitting it updates.
 *
 * A null mark records nothing and returns null. That is the case where the
 * module could not be marked at all — Writing or Speaking on a plan without AI
 * marking, or a marker that was unreachable — and it is the one place this
 * feature could destroy something. A retake stored with no band, or with a
 * placeholder, would replace a real band in the standing form with a gap; a
 * learner would open history and find the 7.0 they earned last month has become
 * "not marked" because they tried to improve it. So nothing is written, the
 * standing form keeps the band it had, and the screen says why.
 *
 * A session with no `of` is refused for the same reason a full sitting is: it
 * is not a retake, so there is no `MockExamReport` for a `MockRetake.of` to
 * name. `of` is exactly the field a standalone single-skill exam leaves unset
 * on `MockRetakeIntent` — components/exam/MockSkillResults.tsx never calls
 * this function, but the guard stays regardless, because the one thing worse
 * than a retake silently failing to record is a standalone sitting silently
 * being recorded as one.
 */
export function recordRetake(
  session: MockSession,
  mark: ModuleMark | null,
  at: string,
): MockRetake | null {
  const intent = session.retake;
  if (!intent?.of || !mark) return null;
  const retake: MockRetake = {
    id: session.id,
    of: intent.of,
    module: intent.module,
    band: mark.band,
    raw: mark.raw,
    total: mark.total,
    startedAt: session.startedAt,
    completedAt: at,
  };
  addMockRetake(retake);
  return retake;
}
