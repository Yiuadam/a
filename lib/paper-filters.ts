/*
  What a learner is allowed to narrow a list of papers down by.

  The chooser screens are libraries — twenty reading papers, twenty-one
  listening, thirty writing tasks — and a library that can only be scrolled is
  a library you read from the top every time. The bar these words drive sits
  above the cards and takes the list down to the papers of one kind.

  Two skills answer "of one kind" with different words, and the difference is
  not a style choice. Reading and listening papers carry an authored
  `difficulty`, so their bar offers exactly the three words the content bank
  uses. Writing tasks carry an authored `type` — what the task asks you to
  produce — because nobody ever wrote a difficulty for them, and inventing one
  from a word count or a CEFR level would be a filter a learner would trust
  and should not. Speaking has no list at all: it is one session that chooses
  its own topics, so there is nothing to filter and it gets no bar.

  ---------------------------------------------------------------------------
  Why the writing words are these four

  A writing task is classified twice over in the bank — Task 1 or Task 2, and
  within Task 2 an essay type that the titles carry in brackets: opinion,
  discussion, problem-solution, two-part question, advantages and
  disadvantages. Offering all of that is nine stops, and nine stops do not fit
  a 390px phone, which is the screen this bar exists for. It would also slice
  fourteen essays into buckets of two.

  So the bar names the four things a task actually asks you to produce: read a
  chart, read a table, write a letter, write an essay. Those are the four
  different activities in the bank — a candidate practising letters is sitting
  General Training, and one practising charts is doing a job that has nothing
  to do with holding an argument. The essay types stay in the titles, where
  they already read as English rather than as filter values.

  The honest cost of that grouping: Essay is fourteen of the thirty, so for
  half the bank this bar narrows less than it does for the other half. Fixing
  that needs a second level, and a second level needs stops like "advantages
  and disadvantages" to fit next to four others on a phone, which they do not.

  ---------------------------------------------------------------------------
  Why the vocabularies are closed sets, declared here

  Because the failure they prevent is silent. A paper whose word matches no
  stop still appears under All and vanishes from every other one, and nothing
  throws — a capital letter is enough to do it. So there is one list per skill,
  tests/paper-filters.test.mjs walks the bank and fails when a paper carries a
  word no stop offers, and scripts/validate-content.mjs refuses to build a
  writing task with no type or a type its own content contradicts.
*/

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const WRITING_TASK_TYPES = ["chart", "table", "letter", "essay"] as const;
export type WritingTaskType = (typeof WRITING_TASK_TYPES)[number];

export type PaperFilterKind = "reading" | "listening" | "writing";

/** The stops this skill's bar offers, in the order they are shown. */
export function filterValuesFor(kind: PaperFilterKind): readonly string[] {
  return kind === "writing" ? WRITING_TASK_TYPES : DIFFICULTIES;
}

/** What the bar itself is called, for the reader who cannot see it. */
export function filterNameFor(kind: PaperFilterKind): string {
  return kind === "writing" ? "Task type" : "Difficulty";
}

const LABELS: Record<string, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
  chart: "Chart",
  table: "Table",
  letter: "Letter",
  essay: "Essay",
};

/*
  Written out rather than capitalised by CSS, for the same reason the CEFR
  code on the card is not: a text-transform is a rule about glyphs, and the
  moment a word wants anything but its first letter changed — "two-part", say —
  the rule is wrong and nothing says so.
*/
export function filterLabel(value: string): string {
  return LABELS[value] ?? value;
}

/*
  A paper's own filter word, whichever field it keeps it in.

  Deliberately structural rather than typed against ReadingTest and
  WritingTask: this module is what lib/types.ts imports WritingTaskType from,
  and importing the interfaces back would be a circle drawn for no gain. What
  matters here is that a paper has one word, not which interface it came from.

  Lower-cased on the way through so a paper authored as "Easy" lands in the
  Easy stop rather than falling out of all of them. That is a courtesy, not the
  guarantee — the test is the guarantee, because a courtesy cannot catch
  "fairly hard".
*/
export function filterValueOf(paper: { difficulty?: string; type?: string }): string {
  return (paper.difficulty ?? paper.type ?? "").trim().toLowerCase();
}
