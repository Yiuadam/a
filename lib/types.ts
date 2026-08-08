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
  questions: string[];
}

export interface SpeakingCueCard {
  id: string;
  topic: string;
  cueCard: string;
  bullets: string[];
  followUp: string[];
}

export interface SpeakingPart3Set {
  topic: string;
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

export interface ModuleResult {
  module: ModuleName;
  testId: string;
  testTitle: string;
  band: number;
  raw?: number;
  total?: number;
  date: string;
}

export interface GeneratedTest {
  kind: "reading" | "listening";
  createdAt: string;
  test: ReadingTest | ListeningTest;
}

export interface Profile {
  placement?: PlacementResult;
  /** Question ids from the last two placement sittings, newest first. */
  placementHistory?: string[][];
  targetBand?: number;
  results: ModuleResult[];
  genTests: GeneratedTest[];
}
