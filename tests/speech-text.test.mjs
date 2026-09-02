import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const root = process.cwd();
const { spokenForm } = await import(pathToFileURL(join(root, "lib", "speech-text.ts")).href);

/*
  Each rule here answers a mispronunciation read off Kokoro's own phoneme
  output, which the browser runtime yields alongside the audio. The phoneme
  string that motivated the rule is quoted in lib/speech-text.ts. What this
  file guards is the other half: that the rules stay narrow, and that a paper
  full of prices, years and spelled-out surnames goes through untouched.
*/

test("a telephone number is spoken as digits rather than as a quantity", () => {
  // Kokoro reads the second group of "07700 900426" as "nine hundred thousand
  // four hundred and twenty-six", which a candidate cannot write back down.
  assert.equal(
    spokenForm("It's my mobile. The number is 07700 900426."),
    "It's my mobile. The number is 0 7 7 0 0, 9 0 0 4 2 6.",
  );
  assert.equal(spokenForm("Call 0800 731 0088."), "Call 0 8 0 0, 7 3 1, 0 0 8 8.");
});

test("a hyphen between digits stops being spoken as the word 'to'", () => {
  // Measured: "0-7-7-0-0" phonemises as zero tə seven tə seven tə zero tə zero.
  assert.equal(
    spokenForm("My mobile is 0-7-7-0-0, then 9-1-4-2-6-3."),
    "My mobile is 0 7 7 0 0, then 9 1 4 2 6 3.",
  );
  assert.equal(spokenForm("quote the reference number LP-4487"), "quote the reference number LP 4487");
});

test("a range keeps its 'to', because that is what a person says", () => {
  assert.equal(spokenForm("It takes 10-15 minutes."), "It takes 10 to 15 minutes.");
});

test("an identifier is spelled out only when the words next to it say it is one", () => {
  assert.equal(spokenForm("the membership number is 22581"), "the membership number is 2 2 5 8 1");
  // The cue has to be adjacent. A turn that reads a number out and then
  // mentions a large quantity must not have the quantity spelled out too.
  assert.equal(
    spokenForm("The number is 07700 900426. We had 25000 visitors."),
    "The number is 0 7 7 0 0, 9 0 0 4 2 6. We had 25000 visitors.",
  );
});

test("a dotted clock time becomes the colon the engines already read correctly", () => {
  // Measured: "6.30 pm" is "six point three zero p m"; "8:14" is "eight fourteen".
  assert.equal(spokenForm("The class starts at 6.30 pm."), "The class starts at 6:30 pm.");
  assert.equal(spokenForm("The 8:14 from Ashford"), "The 8:14 from Ashford");
  // A price is the same shape as a time and must survive it.
  assert.equal(spokenForm("cheese at 1.50 a kilo"), "cheese at 1.50 a kilo");
  assert.equal(spokenForm("The reading was 12.5 per cent."), "The reading was 12.5 per cent.");
});

test("a decade is written out so its plural is not left stranded", () => {
  // Measured: "1980s" phonemises as "nineteen eighty z".
  assert.equal(spokenForm("in the early 1980s"), "in the early nineteen eighties");
  // Anything whose span is a matter of opinion is left alone.
  assert.equal(spokenForm("in the 1900s"), "in the 1900s");
  assert.equal(spokenForm("in the 2000s"), "in the 2000s");
});

test("what the engines already say correctly is passed through untouched", () => {
  for (const line of [
    "The monthly fee is 42 pounds.",
    "That works out at 105 pounds in total.",
    "Sure. It's M-A-R-S-D-E-N. Marsden.",
    "Reference 4487, issued in 2005.",
    "Between 1998 and 2004 the figure doubled.",
    "Roughly 25000 hectares were replanted.",
    "a well-known back road",
    "It is a state-of-the-art facility.",
  ]) {
    assert.equal(spokenForm(line), line, `must not rewrite: ${line}`);
  }
});

test("preparing a line twice changes nothing the second time", () => {
  const files = readdirSync(join(root, "data")).filter((name) => /^listening-\d+\.json$/u.test(name));
  assert.ok(files.length > 0, "no listening papers found");
  for (const file of files) {
    const paper = JSON.parse(readFileSync(join(root, "data", file), "utf8"));
    for (const turn of paper.script) {
      const once = spokenForm(turn.text);
      assert.equal(spokenForm(once), once, `${paper.id} is not stable under a second pass`);
    }
  }
});

test("across the whole catalogue only a handful of lines are rewritten at all", () => {
  /*
    A normaliser that touches most of the script is a normaliser that will
    eventually break a line nobody checked. The papers are written carefully —
    money as "42 pounds", no currency symbols, no slashed dates — so the honest
    expectation is that this changes very little. If a future paper pushes this
    over the bound, that is worth a look rather than a bigger number here.
  */
  const files = readdirSync(join(root, "data")).filter((name) => /^listening-\d+\.json$/u.test(name));
  let turns = 0;
  let changed = 0;
  for (const file of files) {
    const paper = JSON.parse(readFileSync(join(root, "data", file), "utf8"));
    for (const turn of paper.script) {
      turns += 1;
      if (spokenForm(turn.text) !== turn.text) changed += 1;
    }
  }
  assert.ok(turns > 100, "expected a substantial catalogue to measure against");
  assert.ok(
    changed / turns < 0.05,
    `expected under 5% of turns to be rewritten, got ${changed} of ${turns}`,
  );
});
