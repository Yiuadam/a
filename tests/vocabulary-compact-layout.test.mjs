import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const vocabularyPage = readFileSync(join(root, "app", "vocabulary", "page.tsx"), "utf8");
const drillSection = readFileSync(join(root, "components", "DrillSection.tsx"), "utf8");
const drillStyles = readFileSync(join(root, "components", "DrillSection.module.css"), "utf8");
const moreComing = readFileSync(join(root, "components", "MoreComing.tsx"), "utf8");
const vocabulary = JSON.parse(readFileSync(join(root, "data", "vocabulary.json"), "utf8"));

test("Vocabulary opts into a self-contained compact drill layout rather than the shared dense wrapper", () => {
  assert.match(vocabularyPage, /data-vocabulary-practice/);
  assert.match(vocabularyPage, /<DrillSection\s+compact/);
  assert.doesNotMatch(
    vocabularyPage,
    /drill-dense/,
    "Vocabulary should not depend on the global Grammar/Vocabulary selector for its geometry",
  );
  assert.ok(vocabulary.topics.length >= 8, "the compact grid must still expose every authored vocabulary topic");
});

test("the compact index is a readable two-column phone grid and an exact four-topic desktop row", () => {
  assert.match(drillSection, /data-drill-topic-index=\{compact \? "true" : undefined\}/);
  assert.match(drillStyles, /\.compactGrid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(
    drillStyles,
    /@media \(min-width: 48rem\)\s*\{[\s\S]*?\.compactGrid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/,
  );
  assert.match(drillStyles, /\.compactCard\s*\{[\s\S]*?min-height:\s*7\.25rem/);
  assert.match(
    drillStyles,
    /@media \(max-width: 47\.999rem\)[\s\S]*?\.compactSummary\s*\{\s*display:\s*none/,
    "phone cards should show their complete title, status, level, and question count instead of an unreadable clipped excerpt",
  );
  assert.match(drillSection, /onClick=\{\(\) => setOpenId\(t\.id\)\}/);
});

test("the coming-soon notice is a slim full-width footer, not a ninth topic that forces another card row", () => {
  assert.match(drillSection, /data-drill-more-coming/);
  assert.match(drillSection, /<MoreComing what=\{`\$\{kind\} topics`\} className=\{styles\.compactMore\}/);
  assert.match(drillStyles, /\.compactMoreCell\s*\{\s*grid-column:\s*1\s*\/\s*-1/);
  assert.match(drillStyles, /\.compactMore\s*\{[\s\S]*?grid-template-columns:\s*auto minmax\(0, 1fr\)/);
  assert.match(moreComing, /className = ""/);
  assert.match(moreComing, /practice-paper-card[\s\S]*?\$\{className\}/);
});

test("an open compact topic keeps every teaching point visible beside the current drill on desktop", () => {
  assert.match(drillSection, /data-drill-workspace/);
  assert.match(drillSection, /data-drill-compact="true"/);
  assert.match(drillSection, /topic\.summary/);
  assert.match(drillSection, /topic\.points\.map/);
  assert.match(drillSection, /<Drill topic=\{topic\} onExit=\{\(\) => setOpenId\(null\)\}/);
  assert.match(
    drillStyles,
    /@media \(min-width: 64rem\)[\s\S]*?\.compactWorkspace\s*\{[\s\S]*?grid-template-columns:\s*minmax\(15rem, 0\.82fr\) minmax\(0, 1\.18fr\)/,
  );
  assert.match(
    drillStyles,
    /@media \(min-width: 64rem\)[\s\S]*?\.compactWorkspace\s*\{[\s\S]*?align-items:\s*stretch/,
  );
  assert.doesNotMatch(
    drillStyles,
    /\.compactLesson\s*\{[^}]*display:\s*none/,
    "the lesson cannot disappear merely to put the question above the fold",
  );
});

test("compact mode preserves the existing access and lock behaviour", () => {
  assert.match(drillSection, /if \(access\.pending\)/);
  assert.match(drillSection, /if \(beyond\)/);
  assert.match(drillSection, /<LockedCard/);
  assert.match(drillSection, /drillLockReason\(access\.tier\)/);
  assert.match(drillSection, /orderTopics\(topics, access\.tier\)/);
});
