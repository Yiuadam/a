import type { ChartSpec } from "./chart";
// Shared content and result types for the IELTS prep app.

export type CEFRLevel = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";
export type PlacementSkill = "grammar" | "vocabulary" | "reading";

export interface PlacementQuestion {
  id: string;
  level: CEFRLevel;
  skill: PlacementSkill;
  question: string;
  options: string[];
  answer: number;
  /** Why the key is right — shown in the review after the test. */
  explanation?: string;
}

export interface PlacementData {
  questions: PlacementQuestion[];
}

// ---- Reading / Listening question types ----

export interface TFNGQuestion {
  id: string;
  type: "tfng";
  statement: string;
  answer: "TRUE" | "FALSE" | "NOT GIVEN";
  /** Why the key is right — shown in the review after the test. */
  explanation?: string;
}

export interface MCQQuestion {
  id: string;
  type: "mcq";
  question: string;
  options: string[];
  answer: number;
  explanation?: string;
}

export interface CompletionQuestion {
  id: string;
  type: "completion";
  sentence: string;
  answer: string;
  maxWords: number;
  explanation?: string;
}

/**
 * Yes / No / Not Given — and deliberately not the same type as True/False.
 *
 * The two look identical and are not. True/False/Not Given asks whether a
 * statement matches the *facts* in the passage; Yes/No/Not Given asks whether
 * it matches the *writer's views*. A candidate who answers one as though it
 * were the other loses marks while being sure they were right, and the labels
 * on screen are the only thing that tells them which task they are doing. A
 * shared type with a flag would have put those labels one boolean away from
 * being wrong.
 */
export interface YNNGQuestion {
  id: string;
  type: "ynng";
  statement: string;
  answer: "YES" | "NO" | "NOT GIVEN";
  explanation?: string;
}

/**
 * Anything answered by choosing from the group's shared bank.
 *
 * One type covers four of the exam's question types — matching headings,
 * matching information to paragraphs, matching features, and matching sentence
 * endings — because they differ in rubric rather than in mechanics. What tells
 * them apart is the group's `instruction` and what its `sharedOptions` hold:
 * roman-numeralled headings, or names, or clause endings.
 *
 * `answer` is an option `key`, so a bank that changes its wording does not
 * silently invalidate every answer in the group.
 */
export interface MatchingQuestion {
  id: string;
  type: "matching";
  /** "Paragraph C", "The 1974 survey", "Researchers found that…" */
  prompt: string;
  answer: string;
  explanation?: string;
}

/**
 * A question answered in the candidate's own words, within a word limit.
 *
 * Distinct from `completion`, which gives a sentence with a gap in it. Here
 * there is a question and no scaffolding, so more than one phrasing can be
 * right — `accept` carries the alternatives, and marking is case- and
 * punctuation-insensitive like completion.
 */
export interface ShortAnswerQuestion {
  id: string;
  type: "short-answer";
  question: string;
  answer: string;
  /** Other wordings that are equally correct. */
  accept?: string[];
  maxWords: number;
  explanation?: string;
}

export type TestQuestion =
  | TFNGQuestion
  | MCQQuestion
  | CompletionQuestion
  | YNNGQuestion
  | MatchingQuestion
  | ShortAnswerQuestion;

/**
 * One entry in a bank of answers shared by a whole block of questions — the
 * list of headings in a matching-headings task, for instance.
 *
 * `key` is what the candidate actually writes ("vii", "C"); `text` is what it
 * stands for. Both are needed after the test as well as during it: a review
 * that reported only "vii" would be telling a learner nothing, because the
 * bank is no longer on screen beside it.
 */
export interface SharedOption {
  key: string;
  text: string;
}

/**
 * A block of questions sharing one rubric, and sometimes one bank of answers.
 *
 * The exam does not present forty independent questions; it presents blocks —
 * "Questions 14-19: Choose the correct heading for each paragraph" — with the
 * instruction and the heading list printed once above the block. Six of the
 * question types still to be built are unbuildable without this, because the
 * constraint they enforce ("each heading may be used only once") lives across
 * sibling questions rather than inside any one of them.
 */
export interface QuestionGroup {
  instruction: string;
  sharedOptions?: SharedOption[];
  questions: TestQuestion[];
}

/**
 * A paper's questions, either as a flat list or as blocks.
 *
 * Every test shipped so far is a flat array, and those stay valid: the union
 * is what lets grouped papers arrive without rewriting the ones that exist.
 * Normalise with `toGroups` / `flatQuestions` in lib/questions.ts rather than
 * discriminating on the shape at each use site.
 */
export type QuestionSet = TestQuestion[] | QuestionGroup[];

/**
 * Practice hands back the answer the moment it is asked for; the exam hands
 * back nothing until the sitting is over. The difference is structural rather
 * than cosmetic — in exam mode the controls that would reveal an answer are
 * never rendered, so there is nothing to un-hide.
 */
export type TestMode = "practice" | "exam";

export interface ReadingTest {
  id: string;
  title: string;
  topic: string;
  difficulty: string;
  /** CEFR level, judged on the passage's actual language demand — not derived from `difficulty`. */
  level: CEFRLevel;
  timeMinutes: number;
  passage: string;
  questions: QuestionSet;
}

export interface ScriptTurn {
  speaker: string;
  text: string;
}

export interface ListeningTest {
  id: string;
  title: string;
  context: string;
  difficulty: string;
  /** CEFR level, judged on the script's actual language demand — not derived from `difficulty`. */
  level: CEFRLevel;
  timeMinutes: number;
  speakers: string[];
  script: ScriptTurn[];
  questions: QuestionSet;
}

// ---- Writing ----

export interface WritingTask {
  id: string;
  task: 1 | 2;
  variant: "academic" | "general";
  title: string;
  /** CEFR level, judged on the demand of the prompt itself. */
  level: CEFRLevel;
  prompt: string;
  /*
    Academic Task 1 presents data one of two ways. A table is the data
    literally; a chart is the data drawn, which is what most real papers ask
    candidates to describe. A task carries one or the other, never both — the
    validator enforces that, because two views of the same figures would let a
    candidate read the numbers off the table and never look at the chart.
  */
  dataTable?: {
    title: string;
    headers: string[];
    rows: string[][];
  };
  chart?: ChartSpec;
  minWords: number;
  timeMinutes: number;
}

export interface WritingTasksData {
  tasks: WritingTask[];
}

// ---- Speaking ----

export interface SpeakingPart1Topic {
  topic: string;
  /** CEFR level of the questions asked under this topic. */
  level: CEFRLevel;
  questions: string[];
}

export interface SpeakingCueCard {
  id: string;
  topic: string;
  /** CEFR level of the extended talk this cue card asks for. */
  level: CEFRLevel;
  cueCard: string;
  bullets: string[];
  followUp: string[];
}

export interface SpeakingPart3Set {
  topic: string;
  /** CEFR level of the discussion questions in this set. */
  level: CEFRLevel;
  questions: string[];
}

export interface SpeakingTopicsData {
  part1: SpeakingPart1Topic[];
  part2: SpeakingCueCard[];
  part3: SpeakingPart3Set[];
}

// ---- Grading results ----

export interface CriterionGrade {
  name: string;
  band: number;
  comment: string;
}

export interface WritingGrade {
  overallBand: number;
  criteria: CriterionGrade[];
  strengths: string[];
  improvements: string[];
  rewrittenExcerpt: string;
}

export interface SpeakingGrade {
  overallBand: number;
  criteria: CriterionGrade[];
  strengths: string[];
  improvements: string[];
  betterAnswerExample: string;
  pronunciationNote: string;
}

// ---- Profile / progress (localStorage) ----

export interface SkillBreakdown {
  correct: number;
  total: number;
}

export interface PlacementResult {
  band: number;
  date: string;
  bySkill: Record<PlacementSkill, SkillBreakdown>;
  byLevel: Record<CEFRLevel, SkillBreakdown>;
}

export type ModuleName = "reading" | "listening" | "writing" | "speaking";

export interface SavedAdviceReport {
  good: string[];
  improve: string[];
}

export interface ObjectiveResultReview {
  kind: "objective";
  questions: QuestionSet;
  answers: Record<string, string | number>;
  advice: SavedAdviceReport;
  source:
    | { kind: "reading"; passage: string }
    | { kind: "listening"; script: ScriptTurn[] };
}

export interface WritingResultAttempt {
  task: WritingTask;
  response: string;
  grade: WritingGrade;
}

export interface WritingResultReview {
  kind: "writing";
  attempts: WritingResultAttempt[];
}

export interface SpeakingTranscriptTurn {
  role: "examiner" | "candidate";
  part: 1 | 2 | 3;
  text: string;
}

export interface SpeakingResultReview {
  kind: "speaking";
  transcript: SpeakingTranscriptTurn[];
  grade: SpeakingGrade;
}

export type ModuleResultReview =
  | ObjectiveResultReview
  | WritingResultReview
  | SpeakingResultReview;

export interface ModuleResult {
  module: ModuleName;
  testId: string;
  testTitle: string;
  band: number;
  raw?: number;
  total?: number;
  date: string;
  /**
   * The exact material shown after this sitting. Older results have no review
   * because earlier builds saved only their score.
   */
  review?: ModuleResultReview;
}

/**
 * One completed full mock sitting.
 *
 * The module-level results remain the source for study plans and detailed
 * feedback. This compact sitting record is what lets History rebuild a single
 * score report and certificate after the learner leaves the results screen.
 * It deliberately stores no name, email or date of birth: those already live
 * in the account profile and should not be copied into the progress archive.
 */
export interface MockExamReport {
  id: string;
  startedAt: string;
  completedAt: string;
  marks: {
    listening: { band: number; raw?: number; total?: number };
    reading: { band: number; raw?: number; total?: number };
    writing: { band: number; raw?: number; total?: number } | null;
    speaking: { band: number; raw?: number; total?: number } | null;
    overall: number | null;
    unmarked: ModuleName[];
  };
}

export interface GeneratedTest {
  kind: "reading" | "listening";
  createdAt: string;
  test: ReadingTest | ListeningTest;
}

export interface Profile {
  placement?: PlacementResult;
  /**
   * Dashboard destinations the learner has opened. This synced, append-only
   * record retires each homepage "New" label across the learner's browsers.
   */
  visited?: string[];
  /** Question ids from the last two placement sittings, newest first. */
  placementHistory?: string[][];
  targetBand?: number;
  /*
    How many days the study plan should run for, chosen by the learner. Absent
    means four weeks, the length every plan had before it could be chosen — a
    learner already working through one must not open the page and find it
    silently shortened. Read it through `resolveDuration` in lib/plan.ts rather
    than directly, because a number written by another build still has to match
    one of the lengths this build offers.
  */
  planDays?: number;
  results: ModuleResult[];
  /** Full-mock score reports, newest first. */
  mockReports?: MockExamReport[];
  /**
   * A deletion tombstone shared between devices. Results at or before this
   * instant stay deleted when an older tab syncs again.
   */
  historyClearedAt?: string;
  /**
   * A placement deletion tombstone, kept as its own field rather than folded
   * into historyClearedAt because a placement is not a row in `results`: it
   * has to be found, cleared and restored by the code that reads it
   * (mergePlacement in lib/progress/merge.ts) rather than by a filter over an
   * array. Both "Clear all history" (components/history/ClearHistoryButton.tsx)
   * and "clear this device" (components/account/ClearDeviceSection.tsx) set
   * this alongside historyClearedAt now — the two clears were deliberately
   * split when this field was introduced, precisely so history could go
   * without placement; the owner has since asked that either control remove
   * everything a learner owns, so both now set every tombstone on this
   * profile together. A placement dated at or before this instant is treated
   * as cleared when an older device or account snapshot syncs again; one
   * dated after it — a genuine re-sit — still merges in normally.
   */
  placementClearedAt?: string;
  /**
   * A drill-score deletion tombstone. Drill scores themselves live in the
   * separate `bandup.drills.v1` snapshot (lib/drills.ts), not in this
   * profile, so there is nowhere on that flat `{ [topicId]: DrillScore }`
   * record to keep a mark that must outlive every score being emptied from
   * it. This profile carries the mark instead: mergeDrillScores
   * (lib/progress/merge.ts) is handed this value — parsed and compared —
   * wherever it is called, so a score dated at or before it is treated as
   * cleared even though the score and the tombstone live in different synced
   * documents. Set by the same two controls, and in the same instant, as
   * historyClearedAt and placementClearedAt above.
   */
  drillsClearedAt?: string;
  /**
   * A saved-word deletion tombstone, the same shape as drillsClearedAt and
   * for the same reason: lookups live in `bandup.lookups.v1`
   * (lib/lookups.ts), so mergeLookups is handed this value rather than
   * finding it on its own document.
   */
  lookupsClearedAt?: string;
  /**
   * Generated-paper deletion tombstones, keyed by the paper id.
   *
   * Removing an item from `genTests` is ambiguous during a two-device merge:
   * it can mean "the learner deleted it" or "this tab has not downloaded it
   * yet". The deletion time makes that intent durable, so an older account or
   * browser snapshot cannot silently restore the paper.
   */
  deletedGenTests?: Record<string, string>;
  genTests: GeneratedTest[];
}
