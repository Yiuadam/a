import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const grammarPage = readFileSync(join(root, "app", "grammar", "page.tsx"), "utf8");
const drills = readFileSync(join(root, "components", "DrillSection.tsx"), "utf8");
const layout = readFileSync(join(root, "components", "DrillSection.module.css"), "utf8");

test("Grammar opts into the scoped compact drill layout, not the legacy horizontal deck", () => {
  assert.match(grammarPage, /<DrillSection\s+compact\s+compactColumns=\{5\}/);
  assert.match(grammarPage, /data-grammar-practice/);
  assert.doesNotMatch(grammarPage, /drill-dense/);
  assert.doesNotMatch(grammarPage, /globals\.css/);
});

test("compact Grammar keeps every topic reachable in a vertical phone grid and a five-column desktop index", () => {
  assert.match(drills, /data-drill-topic-index=\{compact \? "true" : undefined\}/);
  assert.match(drills, /data-drill-more-coming/);
  assert.match(drills, /<MoreComing what=\{`\$\{kind\} topics`\} className=\{styles\.compactMore\}/);

  assert.match(layout, /\.compactGrid \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(layout, /\.compactMoreCell \{\s*grid-column: 1 \/ -1/);
  assert.match(
    layout,
    /@media \(min-width: 80rem\) \{[\s\S]*?\.compactGridFive \{\s*grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/,
  );

  // The previous phone deck used grid-auto-flow and overflow-x. A standard
  // two-column grid lets a learner see all topics by ordinary page scrolling.
  const compactIndex = layout.slice(0, layout.indexOf(".compactWorkspace"));
  assert.doesNotMatch(compactIndex, /grid-auto-flow|overflow-x/);
});

test("opening a Grammar topic retains the full lesson and the existing drill controls", () => {
  assert.match(drills, /data-drill-workspace/);
  assert.match(drills, /<Drill topic=\{topic\} onExit=\{\(\) => setOpenId\(null\)\}/);
  assert.match(drills, /onClick=\{\(\) => setOpenId\(t\.id\)\}/);
  assert.match(
    layout,
    /@media \(min-width: 64rem\) \{[\s\S]*?\.compactWorkspace \{[\s\S]*?grid-template-columns:/,
  );
  assert.match(layout, /\.compactLesson \{\s*position: sticky/);
  assert.match(
    layout,
    /@media \(min-width: 64rem\) \{[\s\S]*?\.compactWorkspace \{[\s\S]*?align-items: stretch/,
    "the desktop lesson and exercise panels should share one row height",
  );
});
