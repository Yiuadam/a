import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");

const chooser = read("components", "TestChooser.tsx");
const listening = read("app", "practice", "listening", "page.tsx");
const reading = read("app", "practice", "reading", "page.tsx");
const writing = read("app", "practice", "writing", "page.tsx");

test("writing enters through the same paper chooser as reading and listening", () => {
  for (const [kind, page] of [
    ["listening", listening],
    ["reading", reading],
    ["writing", writing],
  ]) {
    assert.match(page, /import TestChooser from "@\/components\/TestChooser"/);
    assert.match(
      page,
      new RegExp(`<TestChooser[\\s\\S]{0,240}kind="${kind}"`),
      `${kind} should render the shared paper chooser`,
    );
  }

  assert.match(chooser, /kind:\s*"reading"\s*\|\s*"listening"\s*\|\s*"writing"/);
  assert.match(chooser, /data-paper-chooser/);
  assert.match(chooser, /query\.set\("id", t\.id\)/);
  assert.match(chooser, /`\/practice\/\$\{kind\}\?\$\{query\.toString\(\)\}`/);
});

test("a writing chooser selection opens the exact task and leaves the mobile workspace intact", () => {
  assert.match(writing, /useSearchParams/);
  assert.match(writing, /\.get\("id"\)/);
  assert.match(writing, /tasks\.find\(/);
  assert.match(writing, /missingId=\{[^}]+\}/);
  assert.match(writing, /\["assignment", "from", "preview"\]/);
  assert.match(writing, /retainedQuery=\{retained\.toString\(\)\}/);
  assert.doesNotMatch(writing, /WritingTaskPicker/);

  // Selecting a task changes the entry screen only. The full-width vertical
  // phone workspace remains the layout once that task has been opened.
  assert.match(writing, /function WritingMobilePanels/);
  assert.match(writing, /data-writing-mobile-panels/);
  assert.match(writing, /<WritingMobilePanels[\s\S]*panels=\{practicePanels\}/);
});

test("writing cards describe writing tasks rather than objective-test questions", () => {
  assert.match(chooser, /kind === "listening" \? "Listening" : "Writing"/);
  assert.match(chooser, /\{label\} practice/);
  assert.match(chooser, /Task \$\{writingTask\.task\}/);
  assert.match(chooser, /writingTask\.variant === "academic"/);
  assert.match(chooser, /At least \{writingTask\.minWords\} words/);
  assert.match(chooser, /\{writingTask\.timeMinutes\} min/);
});
