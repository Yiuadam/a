/*
  Whether the papers can be passed without reading them.

  Every multiple-choice question has three or four options, so ticking the
  longest one every time should be right about a quarter to a third of the time.
  It was right 78% of the time across the reading bank and 54% across listening,
  and in half the reading questions the key was visibly longer than anything
  else — eight characters or more, which is a difference you see rather than
  count. A candidate who never opened the passage scored about 78%.

  It happens without anyone deciding it. A correct option has to be precisely
  qualified — "because governing bodies weigh the evidence differently from one
  sport to another" — while a wrong one can be short and blunt: "because it is
  cheaper". Cambridge writes its distractors to the same length for exactly this
  reason.

  Two things made it worth a build failure rather than a note. It makes the
  papers easier than the exam, so a learner's practice band overstates the band
  they would actually get; and it teaches a strategy that will not work on the
  day, which is worse than teaching nothing.

  The fix was to lengthen distractors rather than trim keys. A distractor is
  already false, and making a false statement more specific cannot make it true;
  trimming a correct option to match risks making it ambiguous, which is the
  defect this was trying to remove.
*/
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

function questions(prefix) {
  const out = [];
  for (const file of readdirSync("data").filter((f) => new RegExp(`^${prefix}-\\d+\\.json$`).test(f))) {
    const walk = (o) => {
      if (Array.isArray(o)) return o.forEach(walk);
      if (o && typeof o === "object") {
        if (o.type === "mcq" && Array.isArray(o.options)) {
          const lens = o.options.map((x) => String(x).length);
          const others = lens.filter((_, i) => i !== o.answer);
          out.push({ file, id: o.id, key: lens[o.answer], hi: Math.max(...others), lo: Math.min(...others), n: lens.length });
        }
        Object.values(o).forEach(walk);
      }
    };
    walk(JSON.parse(readFileSync(`data/${file}`, "utf8")));
  }
  assert.ok(out.length > 50, `expected a bank of ${prefix} MCQs, found ${out.length}`);
  return out;
}

/*
  Eight characters is roughly a short word — about where a difference in length
  stops being something you could measure and becomes something you notice while
  reading the options. Four are allowed through for the whole bank because some
  answers are genuinely short and padding them would read as padding: "None" as
  a count, "on Friday" against "on Saturday morning", "economic advantage"
  against a clause. A candidate cannot generalise from those, because the short
  option is wrong far more often than it is right.
*/
const VISIBLE = 8;

for (const prefix of ["reading", "listening"]) {
  test(`${prefix}: no question hands out its answer by length`, () => {
    const qs = questions(prefix);
    const cued = qs.filter((q) => q.key - q.hi >= VISIBLE);
    assert.deepEqual(
      cued.map((q) => `${q.file} ${q.id} (key ${q.key} vs ${q.hi})`),
      [],
      "the correct option must not be visibly the longest",
    );
    const short = qs.filter((q) => q.lo - q.key >= VISIBLE);
    assert.ok(
      short.length <= 4,
      `${short.length} questions make the key visibly the shortest: ${short.map((q) => `${q.file} ${q.id}`).join(", ")}`,
    );
  });

  test(`${prefix}: picking the longest option is no better than guessing`, () => {
    const qs = questions(prefix);
    const longest = qs.filter((q) => q.key > q.hi).length;
    const rate = longest / qs.length;
    // Chance is 1/n. The ceiling allows for ordinary variation without leaving
    // room for a strategy: at four options, chance is 25% and this permits 40%.
    const chance = 1 / (qs.reduce((a, q) => a + q.n, 0) / qs.length);
    assert.ok(
      rate <= chance + 0.15,
      `the longest option is correct ${Math.round(rate * 100)}% of the time in ${prefix}, against ~${Math.round(chance * 100)}% by chance`,
    );
  });
}
