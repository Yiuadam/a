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
}

export interface MCQQuestion {
  id: string;
  type: "mcq";
  question: string;
  options: string[];
  answer: number;
}

export interface CompletionQuestion {
  id: string;
  type: "completion";
  sentence: string;
  answer: string;
  maxWords: number;
}

export type TestQuestion = TFNGQuestion | MCQQuestion | CompletionQuestion;

export interface ReadingTest {
  id: string;
  title: string;
  topic: string;
  difficulty: string;
  timeMinutes: number;
  passage: string;
  questions: TestQuestion[];
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
  questions: TestQuestion[];
}

// ---- Writing ----

export interface WritingTask {
  id: string;
  task: 1 | 2;
  variant: "academic" | "general";
  title: string;
  prompt: string;
  dataTable?: {
    title: string;
    headers: string[];
    rows: string[][];
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
  targetBand?: number;
  results: ModuleResult[];
  genTests: GeneratedTest[];
}
