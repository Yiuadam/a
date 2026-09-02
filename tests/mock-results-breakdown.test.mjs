/*
  The rules that keep the mock exam's "what to work on next" honest.

  This is the part of a results screen that is easiest to fake and hardest to
  notice being faked. Generic exam advice reads as insight — skim first, watch
  the clock, learn more words — and it is true of everybody, which is exactly
  why it is worth nothing to the person who has just spent two and three-
  quarter hours earning a specific answer. Every assertion here is about
  refusing to say something: not from three questions, not from one mistake,
  and not when the marks are spread evenly and there is nothing to say.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const { marksToNextBand, markPapers, observations, talliesByType, talliesByPaper } = await import(
  pathToFileURL(join(process.cwd(), "lib", "exam", "breakdown.ts")).href
);
const { rawToBand } = await import(pathToFileURL(join(process.cwd(), "lib", "band.ts")).href);

/** A True/False question, which `isCorrect` marks by string comparison. */
function tfng(id) {
  return { id, type: "tfng", statement: id, answer: "TRUE" };
}

function mcq(id) {
  return { id, type: "mcq", question: id, options: ["a", "b"], answer: 0 };
}

/** `count` questions of one type, named so a paper can hold several kinds. */
function block(make, prefix, count) {
  return Array.from({ length: count }, (_, i) => make(`${prefix}-${i + 1}`));
}

function paper(label, questions) {
  return { label, title: label, questions };
}

/** Answer every question, right or wrong according to `isRight`. */
function answerAll(papers, isRight) {
  const answers = {};
  for (const p of papers) {
    for (const q of p.questions) {
      if (!isRight(q)) {
        answers[q.id] = q.type === "mcq" ? 1 : "FALSE";
        continue;
      }
      answers[q.id] = q.type === "mcq" ? 0 : "TRUE";
    }
  }
  return answers;
}

test("the distance to the next band is whatever the conversion table says it is", () => {
  /*
    The number printed beside every band, and the reason a raw score is printed
    at all. It has to be derived from `rawToBand` rather than from a second
    copy of the table, because two candidates on the same band are told
    different things and only the table knows which.
  */
  for (let raw = 0; raw < 40; raw++) {
    const next = marksToNextBand(raw, 40, "listening");
    if (next === null) continue;
    assert.equal(
      rawToBand(raw + next.marks, 40, "listening"),
      next.band,
      `${raw} + ${next.marks} was said to reach ${next.band}`,
    );
    assert.ok(next.band > rawToBand(raw, 40, "listening"), "the next band must be higher");
    /* Nothing smaller than `marks` may already reach it, or the promise is wrong. */
    for (let closer = 1; closer < next.marks; closer++) {
      assert.equal(rawToBand(raw + closer, 40, "listening"), rawToBand(raw, 40, "listening"));
    }
  }
});

test("a full mark says nothing about the next band, because there is not one", () => {
  assert.equal(marksToNextBand(40, 40, "listening"), null);
  assert.equal(marksToNextBand(39, 40, "reading"), null, "39 is already band 9");
});

test("a weakness is named when the marks gather on one question type", () => {
  /*
    The observation the owner asked for: four of six lost on one task, against
    a paper the candidate otherwise handled. This is the case where saying
    something is both true and useful.
  */
  const papers = [paper("Passage 1", [...block(tfng, "t", 6), ...block(mcq, "m", 20)])];
  const wrong = new Set(["t-1", "t-2", "t-3", "t-4", "m-1"]);
  const marked = markPapers(papers, answerAll(papers, (q) => !wrong.has(q.id)));

  const found = observations("reading", marked, papers);
  const type = found.find((o) => o.id.startsWith("type-"));
  assert.ok(type, "four of six on one type is a pattern and must be reported");
  assert.match(type.fact, /True \/ False \/ Not Given cost you 4 of its 6 marks/);
  assert.match(type.fact, /19 of the other 20 right/);
  assert.ok(type.fix, "a named task carries the habit that fixes it");
});

test("a candidate who is evenly wrong everywhere is told nothing about types", () => {
  /*
    The whole point of the contrast rule. Half of everything wrong is a band,
    not a diagnosis, and listing every question type they dropped marks on
    would be the band read back to them as though it were advice.
  */
  const papers = [paper("Passage 1", [...block(tfng, "t", 10), ...block(mcq, "m", 10)])];
  const marked = markPapers(
    papers,
    answerAll(papers, (q) => Number(q.id.split("-")[1]) % 2 === 0),
  );

  const found = observations("reading", marked, papers);
  assert.deepEqual(
    found.filter((o) => o.id.startsWith("type-")),
    [],
    "no type is worse than the rest of this paper, so no type may be named",
  );
});

test("a group too small to mean anything is never named", () => {
  /*
    Three questions all wrong is a higher share than anything else on the
    paper, and it is still one bad guess about one part of one passage.
  */
  const papers = [paper("Passage 1", [...block(tfng, "t", 3), ...block(mcq, "m", 30)])];
  const wrong = new Set(["t-1", "t-2", "t-3"]);
  const marked = markPapers(papers, answerAll(papers, (q) => !wrong.has(q.id)));

  assert.deepEqual(observations("reading", marked, papers).filter((o) => o.id.startsWith("type-")), []);
});

test("one mistake is a mistake rather than a pattern", () => {
  const papers = [paper("Passage 1", [...block(tfng, "t", 6), ...block(mcq, "m", 30)])];
  const marked = markPapers(papers, answerAll(papers, (q) => q.id !== "t-1"));

  assert.deepEqual(observations("reading", marked, papers), [], "one wrong answer supports nothing");
});

test("a perfect paper produces no advice at all", () => {
  const papers = [paper("Passage 1", block(tfng, "t", 20))];
  const marked = markPapers(papers, answerAll(papers, () => true));
  assert.deepEqual(observations("reading", marked, papers), []);
});

test("a section is named against the rest of the paper, not against itself", () => {
  const papers = [
    paper("Passage 1", block(tfng, "a", 13)),
    paper("Passage 2", block(tfng, "b", 13)),
    paper("Passage 3", block(tfng, "c", 13)),
  ];
  const wrong = new Set(["c-1", "c-2", "c-3", "c-4", "c-5", "c-6", "c-7", "a-1"]);
  const marked = markPapers(papers, answerAll(papers, (q) => !wrong.has(q.id)));

  const section = observations("reading", marked, papers).find((o) => o.id.startsWith("paper-"));
  assert.ok(section, "seven of thirteen in one passage against one everywhere else is a pattern");
  assert.match(section.fact, /Passage 3 cost you 7 of its 13 marks, against 1 across the rest/);
});

test("blanks are counted as blanks, and only said to be late when they are", () => {
  /*
    An empty box and a wrong answer cost the same mark and mean different
    things — one is English, the other is the clock or a lost place in the
    recording. The second sentence, about where they fell, is printed only
    where they really did fall there.
  */
  const papers = [
    paper("Part 1", block(tfng, "a", 10)),
    paper("Part 2", block(tfng, "b", 10)),
  ];
  const late = markPapers(papers, {
    ...answerAll(papers, () => true),
    "b-9": undefined,
    "b-10": undefined,
    "b-8": undefined,
  });
  const lateBlank = observations("listening", late, papers).find((o) => o.id === "blanks");
  assert.ok(lateBlank);
  assert.match(lateBlank.fact, /You left 3 questions empty, 3 of them in Part 2\./);

  const spread = markPapers(papers, {
    ...answerAll(papers, () => true),
    "a-1": undefined,
    "b-1": undefined,
  });
  const spreadBlank = observations("listening", spread, papers).find((o) => o.id === "blanks");
  assert.ok(spreadBlank);
  assert.equal(spreadBlank.fact, "You left 2 questions empty.");
});

test("the tallies count what the candidate actually saw", () => {
  const papers = [
    paper("Part 1", block(tfng, "a", 4)),
    paper("Part 2", block(mcq, "b", 4)),
  ];
  const marked = markPapers(papers, answerAll(papers, (q) => q.id !== "b-1"));

  assert.deepEqual(
    talliesByPaper(marked, papers).map((t) => `${t.label} ${t.right}/${t.total}`),
    ["Part 1 4/4", "Part 2 3/4"],
  );
  assert.deepEqual(
    talliesByType(marked).map((t) => `${t.label} ${t.right}/${t.total}`),
    ["True / False / Not Given 4/4", "Multiple choice 3/4"],
  );
});
