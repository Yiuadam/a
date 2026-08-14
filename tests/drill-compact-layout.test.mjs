import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");

const drillSection = read("components", "DrillSection.tsx");
const compactCss = read("components", "DrillSection.module.css");
const vocabularyPage = read("app", "vocabulary", "page.tsx");
const grammarPage = read("app", "grammar", "page.tsx");
const vocabulary = JSON.parse(read("data", "vocabulary.json"));
const grammar = JSON.parse(read("data", "grammar.json"));

/**
 * Return the JSX element which owns a data marker. This intentionally counts
 * only matching tags: it is enough to distinguish the topic grid from its
 * wrapper without needing a TSX parser in this small source-level test.
 */
function markedElement(source, marker) {
  const markerAt = source.indexOf(marker);
  assert.notEqual(markerAt, -1, `missing ${marker}`);

  const start = source.lastIndexOf("<", markerAt);
  const open = source.slice(start).match(/^<([A-Za-z][\w.-]*)\b[^>]*>/);
  assert.ok(open, `${marker} must be on a JSX element`);

  const tag = open[1];
  const tags = new RegExp(`<\\/?${tag}\\b[^>]*>`, "g");
  tags.lastIndex = start;
  let depth = 0;

  for (let match = tags.exec(source); match; match = tags.exec(source)) {
    const token = match[0];
    if (token.startsWith("</")) {
      depth -= 1;
      if (depth === 0) {
        return {
          start,
          end: tags.lastIndex,
          opening: source.slice(start, start + open[0].length),
          content: source.slice(start + open[0].length, match.index),
        };
      }
    } else if (!token.endsWith("/>")) {
      depth += 1;
    }
  }

  assert.fail(`${marker} element is not closed`);
}

test("Vocabulary and Grammar explicitly opt into the shared compact drill layout", () => {
  for (const [name, page] of [
    ["Vocabulary", vocabularyPage],
    ["Grammar", grammarPage],
  ]) {
    const drillUse = page.slice(page.indexOf("<DrillSection"), page.indexOf("<DrillSection") + 700);
    assert.match(drillUse, /\bcompact(?:\s|=|\/)/, `${name} must opt in instead of changing every drill page`);
  }

  assert.match(drillSection, /compact = false/);
  assert.match(drillSection, /data-drill-compact=\{compact \? "true" : undefined\}/);
  assert.match(drillSection, /data-drill-topic-index/);
  assert.match(drillSection, /data-drill-workspace/);
  assert.match(grammarPage, /compactColumns=\{5\}/);
});

test("the compact topic index holds destinations in two desktop rows and keeps More Coming slim", () => {
  assert.equal(vocabulary.topics.length, 8, "the vocabulary chooser has eight destinations");
  assert.equal(grammar.topics.length, 10, "the grammar chooser has ten destinations");
  assert.equal(Math.ceil(vocabulary.topics.length / 4), 2, "four vocabulary columns make two rows");
  assert.equal(Math.ceil(grammar.topics.length / 5), 2, "five grammar columns make two rows");

  const index = markedElement(drillSection, "data-drill-topic-index");
  const more = markedElement(drillSection, "data-drill-more-coming");
  const topicMapAt = drillSection.indexOf("{ordered.map(", index.start);
  const moreAt = drillSection.indexOf("data-drill-more-coming");

  assert.match(index.opening, /styles\.compactGrid/);
  assert.ok(topicMapAt > index.start && topicMapAt < index.end, "topic cards belong to the labelled grid");
  assert.ok(more.start > topicMapAt, "More Coming follows all topic destinations");
  assert.ok(more.start > index.start && more.end < index.end, "More Coming is a final grid cell, not a topic card");
  assert.ok(moreAt > topicMapAt, "the final notice cannot displace a real topic");
  assert.match(more.opening, /styles\.compactMoreCell/);

  assert.match(
    compactCss,
    /\.compactMoreCell\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*\}/,
    "the notice spans a row rather than taking a sixth/fifth topic slot",
  );
  assert.match(
    compactCss,
    /\.compactMore\s*\{[^}]*min-height:\s*0;[^}]*padding:\s*0\.625rem\s+0\.75rem;[^}]*\}/,
    "the notice is deliberately shorter than a destination card",
  );
  assert.match(
    compactCss,
    /@media \(min-width: 48rem\)\s*\{[\s\S]*?\.compactGrid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/,
  );
  assert.match(
    compactCss,
    /@media \(min-width: 80rem\)\s*\{[\s\S]*?\.compactGridFive\s*\{[\s\S]*?grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\)/,
  );
});

test("compact topic choices use a deliberate readable phone contract without horizontal overflow", () => {
  /*
    The compact phone index intentionally has two short chooser cards per row.
    It keeps the full title, level/status and question count; the explanatory
    sentence is hidden only here, because its full summary and every teaching
    point remain visible after opening the topic. This avoids a horizontal deck
    or a third text-heavy row while leaving the lesson itself uncompromised.
  */
  assert.match(
    compactCss,
    /\.compactGrid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);[^}]*\}/,
    "the phone chooser stays within the viewport rather than creating a horizontal deck",
  );
  assert.match(
    compactCss,
    /\.compactCardTitle\s*\{[^}]*font-size:\s*0\.8125rem;[^}]*line-height:\s*1\.1rem;[^}]*\}/,
    "topic titles retain the measured readable 13px / 17.6px minimum",
  );
  assert.match(
    compactCss,
    /@media \(max-width: 47\.999rem\)\s*\{[\s\S]*?\.compactSummary\s*\{[\s\S]*?display:\s*none;/,
    "only the duplicated index summary is removed on a phone",
  );
});

test("an open compact topic shows the full lesson beside the live exercise on desktop", () => {
  const workspace = markedElement(drillSection, "data-drill-workspace");

  assert.match(workspace.opening, /styles\.compactWorkspace/);
  assert.match(workspace.content, /data-lookupable/);
  assert.match(workspace.content, /topic\.summary/);
  assert.match(workspace.content, /topic\.points\.map/);
  assert.match(workspace.content, /<Drill\s+topic=\{topic\}/);
  assert.doesNotMatch(workspace.content, /<details\b|<summary\b|(?:^|\s)hidden(?:\s|=|>|\/)/);
  assert.match(
    compactCss,
    /@media \(min-width: 64rem\)\s*\{[\s\S]*?\.compactWorkspace\s*\{[\s\S]*?grid-template-columns:\s*minmax\([^)]*\)\s+minmax\([^)]*\)/,
    "desktop gives the lesson and the active exercise independent columns",
  );
});
