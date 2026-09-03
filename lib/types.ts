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

/**
 * "Choose TWO letters, A-E" (sometimes THREE, from A-G) — real IELTS Listening
 * and Reading, and asked from one list of options rather than the
 * sentence-by-sentence prompts the other grouped types use.
 *
 * It looks like `MCQQuestion` with more than one answer and is not, in two
 * ways that matter. First, one of these is worth `numAnswers` marks rather
 * than one, and it claims that many consecutive numbers in the paper —
 * "Questions 15 and 16" prints beside a single prompt — even though it is
 * authored, asked and answered as one item; `numAnswers` carries both facts,
 * and `questionWidth` in lib/questions.ts is the one other place that has to
 * read it that way. Second, the real exam's rule for it cannot be reduced to
 * a single right-or-wrong: each correct letter is a mark on its own, order is
 * never significant (B,D and D,B are the same answer), and choosing more
 * letters than asked for scores nothing at all for the group, not one mark
 * short. See `isCorrect` and `marksEarned` in lib/band.ts, which is where
 * that rule actually lives.
 */
export interface MultiSelectQuestion {
  id: string;
  type: "multi-select";
  question: string;
  options: string[];
  /** How many letters are correct — 2 or 3 in the real exam — and how many question numbers the group claims. */
  numAnswers: number;
  /** Indices into `options`, exactly `numAnswers` of them. Order carries no meaning. */
  answer: number[];
  explanation?: string;
}

export interface CompletionQuestion {
  id: string;
  type: "completion";
  sentence: string;
  answer: string;
  /**
   * Other spellings a marker would accept, the same field short-answer has.
   *
   * It exists because the normaliser stopped stripping a full stop between two
   * digits — it was turning the key "3.8" into "38", which marked a correct
   * decimal wrong. The strip was also what let a candidate write 930 for a key
   * of 9.30, and that tolerance is worth keeping; a completion question had no
   * way to say so, so now it has one.
   */
  accept?: string[];
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
  | MultiSelectQuestion
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
/**
 * A table or a flow chart that a block's gaps are set into.
 *
 * Table completion and flow-chart completion are not new question types. The
 * questions inside them are ordinary `completion` questions — one gap, one
 * short answer, the same word limit and the same `accept` list — and they are
 * marked by the same code as every other gap in the paper. What the real exam
 * gives them, and what BandUp could not, is a *shape*: a timetable with a
 * column of prices, a process with each stage in its own box. Rendered as a
 * numbered list of sentence fragments, a table completion loses the very thing
 * the candidate is being asked to read, because the answer to "£____ per week"
 * is found by matching the row and the column, not by reading a sentence.
 *
 * So the shape belongs to the block and the marking stays where it was. A
 * group carrying a layout renders as the figure; a group without one renders
 * as the list it always did.
 *
 * Cells are plain strings with `{{id}}` where a gap belongs, naming the
 * question that fills it. A string keeps the content readable as JSON and
 * keeps a cell's text and its gap in the order they are read — "Cost:
 * £{{q5}} per week" is one cell, not three fields. The validator checks that
 * every placeholder names a question in the block and that every question in
 * the block is placed exactly once, so a gap can neither go missing from the
 * figure nor be drawn twice.
 */
export type QuestionLayout = TableLayout | FlowChartLayout | NotesLayout;

export interface TableLayout {
  kind: "table";
  /** Printed once across the top. Omitted by a table whose rows label themselves. */
  columns?: string[];
  /** Row by row, each row left to right. Rows need not be the same length. */
  rows: string[][];
}

export interface FlowChartLayout {
  kind: "flow-chart";
  /** One box per stage, drawn top to bottom and joined by arrows. */
  steps: string[];
}

/**
 * Note completion — the commonest task on the paper, and the one BandUp was
 * furthest from.
 *
 * The real thing is a page of somebody's notes: a title across the top, bold
 * headings dividing it into sections, bullets under each, and the numbered
 * boxes sitting inside the lines. Half the task is reading that structure —
 * a heading tells the candidate which part of the recording they are in, and
 * the indent of a sub-bullet says the line belongs to the one above it. Drawn
 * as a numbered list of separate sentences, all of that is gone, and the
 * candidate is left matching each fragment to the audio on its own.
 */
export interface NotesLayout {
  kind: "notes";
  /** Centred over the notes, as the paper prints it. */
  title?: string;
  sections: NotesSection[];
}

export interface NotesSection {
  /** Bold, above its bullets. Omitted by notes that run straight on. */
  heading?: string;
  /** A plain line, or a line that has its own indented lines beneath it. */
  bullets: Array<string | { text: string; sub: string[] }>;
}

/**
 * A plan or map the block's questions are answered against.
 *
 * The exam's labelling tasks — a site plan, a floor plan, a map of a reserve —
 * put lettered points on a drawing and ask which letter each place is at. The
 * candidate chooses a letter; nothing is drawn or dragged. That means the
 * marking needs nothing new at all: the questions are ordinary `matching`
 * questions answered from the block's own bank of letters, and what was
 * missing was only the picture.
 *
 * Drawn from data rather than shipped as an image, which is the same decision
 * `lib/chart.ts` made for the Task 1 figures. A picture is a file to store, a
 * request to fail, and something no theme, screen size or zoom setting can
 * adapt; a drawing described as rectangles and points is text, renders at any
 * size, takes the paper's own colours, and can say in words what it shows.
 *
 * A `figure` sits above the block's questions rather than replacing them,
 * which is the difference between it and `layout`: a table completion *is* its
 * questions, a plan is the thing they are about.
 */
export type QuestionFigure = PlanFigure;

export interface PlanFigure {
  kind: "plan";
  /** Printed above the drawing, as the paper prints it. */
  title?: string;
  /**
   * Everything is positioned in a 0–100 square and scaled to whatever room the
   * drawing gets, so a plan never has to know how wide the screen is.
   */
  areas: PlanArea[];
  /** A road, path or river: points joined in the order given. */
  routes?: PlanRoute[];
  /**
   * The lettered points the candidate chooses between.
   *
   * Absent on a plan that is being *described* rather than labelled — a
   * Writing Task 1 map has named blocks and no letters, because nothing is
   * being chosen from it. A listening labelling block must have them, and the
   * validator requires them there rather than here.
   */
  markers?: PlanMarker[];
  /** Where a visitor comes in, which most plans print and some questions need. */
  entrance?: { x: number; y: number; label: string };
}

export interface PlanArea {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Named on the drawing. An unnamed block is scenery — a lake, a field. */
  label?: string;
}

export interface PlanRoute {
  points: Array<{ x: number; y: number }>;
  label?: string;
}

export interface PlanMarker {
  /** "A", "B", … — and the same key the block's bank offers. */
  key: string;
  x: number;
  y: number;
}

export interface QuestionGroup {
  instruction: string;
  sharedOptions?: SharedOption[];
  /** Draw this block as a table or a flow chart rather than as a numbered list. */
  layout?: QuestionLayout;
  /** A plan or map printed above the block's questions. */
  figure?: QuestionFigure;
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
  /**
   * An estimate, authored alongside the paper rather than measured from a
   * candidate sitting it — which is exactly why no learner ever sees this
   * word. It orders the library easiest-first (lib/tests.ts) and steers
   * AI generation (app/api/generate/route.ts) toward a target band; it does
   * not drive a filter or a card label any more. Presenting an estimate as a
   * fact a learner could rely on was the whole complaint that removed both.
   */
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
  /** Same estimate, same reason it is kept and the same reason it is not shown — see `ReadingTest.difficulty`. */
  difficulty: string;
  /** CEFR level, judged on the script's actual language demand — not derived from `difficulty`. */
  level: CEFRLevel;
  timeMinutes: number;
  speakers: string[];
  script: ScriptTurn[];
  questions: QuestionSet;
}

// ---- Writing ----

/*
  What a writing task asks the candidate to produce: read a chart, read a
  table, write a letter, write an essay. This used to be what the paper
  chooser's filter bar ran on; the bar now runs on `task` instead (a real,
  authored 1-or-2, where this was an essay-vs-letter classification that
  needed a closed vocabulary and a build-time check to keep honest — see
  components/TestChooser.tsx and scripts/validate-content.mjs). The type
  itself stays, because it is still true and still worth checking: an essay
  is a Task 2, a letter is a General Training Task 1, and a chart or a table
  is the one the task actually carries. It just no longer has a bar to feed.
*/
export const WRITING_TASK_TYPES = ["chart", "table", "plan", "process", "letter", "essay"] as const;
export type WritingTaskType = (typeof WRITING_TASK_TYPES)[number];

export interface WritingTask {
  id: string;
  task: 1 | 2;
  variant: "academic" | "general";
  /*
    What this task asks the candidate to produce, authored rather than worked
    out on the fly. The alternative was reading it out of the title: the
    Task 2 titles carry their essay type in brackets, and across the bank
    those brackets say both "problem-solution" and "problem and solution" for
    the same thing, with one title saying nothing at all. Parsing that would
    put the inconsistency straight into whatever reads it.

    Structural, so it can be checked rather than trusted — an essay is a Task
    2, a letter is a General Training Task 1, and a chart or a table is the
    one it actually carries. scripts/validate-content.mjs fails the build on a
    task whose type its own content contradicts, which is what stops this
    drifting away from the paper it describes.
  */
  type: WritingTaskType;
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
  /*
    The third thing Academic Task 1 asks for, after a chart and a table: a map
    or a plan, almost always two of them — the same site before and after, with
    the candidate describing what changed. It is a different piece of writing
    from a chart description, because the language is position and change
    rather than trend and comparison ("the orchard to the north was cleared
    and replaced by"), and a candidate who has only ever practised on charts
    meets it for the first time in the exam.

    Two entries, not one, because a single plan gives nothing to compare and
    the real task is nearly always a pair. Drawn by the same renderer as the
    listening labelling plans; the difference is that these carry no letters.
  */
  plans?: Array<{ caption: string; figure: PlanFigure }>;
  /*
    The fourth Academic Task 1 figure: a process — how something is made, how
    water moves through a system, how a material is recycled. It asks for
    writing the other three do not, because a process has no numbers in it at
    all: the whole answer is sequence and passive voice ("the pulp is then
    pressed into sheets"), and a candidate who has only described charts has
    never had to write a word of it.

    Stages in order, each with an optional note for what happens at it. Drawn as
    boxes joined by arrows rather than as a numbered list, because reading the
    order off a diagram is part of the task.
  */
  process?: {
    title?: string;
    stages: Array<{ label: string; note?: string }>;
  };
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

/**
 * One skill re-sat on its own, against a sitting that already happened.
 *
 * IELTS One Skill Retake, and modelled on what that actually issues: a new Test
 * Report Form carrying the retaken skill's new score beside the original scores
 * for the other three, with the original form still valid. So this is a row of
 * its own rather than an edit to `MockExamReport` — the sitting keeps the bands
 * it produced, permanently, and the form that stands today is derived from the
 * pair. lib/exam/report.ts does the deriving and explains the model in full.
 *
 * That is also what makes this the safe shape. The worst thing this feature
 * could do is lose a band a learner earned, and nothing here can: a retake is
 * only ever appended, so a bad one is a visible extra row rather than a silent
 * overwrite of the number it replaced.
 */
export interface MockRetake {
  id: string;
  /** The `MockExamReport.id` this retake updates. */
  of: string;
  module: ModuleName;
  band: number;
  raw?: number;
  total?: number;
  startedAt: string;
  completedAt: string;
}

export interface GeneratedTest {
  kind: "reading" | "listening";
  createdAt: string;
  test: ReadingTest | ListeningTest;
}

export interface Profile {
  placement?: PlacementResult;
  /*
    Legacy data from builds where opening a module retired its "New" badge.
    Kept while old account snapshots are merged so a sync remains lossless,
    but current badges deliberately ignore it: only a submitted result counts.
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
   * Single-skill retakes, newest first, each naming the sitting it updates.
   *
   * A separate list rather than a field inside each report, and the merge is
   * why. Two devices that each recorded a retake against the same sitting would
   * hold two copies of one report id, and `unionBy` in lib/progress/merge.ts
   * keeps one of them — so a nested list would lose whichever retake happened
   * to arrive second. Flat rows with their own ids union without dropping any.
   */
  mockRetakes?: MockRetake[];
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
