import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const {
  DRILL_TOPIC_IDS,
  drillNeedsNewBadge,
  drillSectionNeedsNewBadge,
  moduleNeedsNewBadge,
  paperNeedsNewBadge,
} = await import(pathToFileURL(join(process.cwd(), "lib", "completion-badges.ts")).href);

const result = (module, testId) => ({
  module,
  testId,
  testTitle: testId,
  band: 6,
  date: "2026-08-12T00:00:00.000Z",
});

test("opening a homepage skill retires only that skill's New badge", () => {
  const profile = { visited: ["reading"], results: [] };
  assert.equal(moduleNeedsNewBadge(profile, "reading"), false);
  assert.equal(moduleNeedsNewBadge(profile, "listening"), true);
});

test("a submitted result retires only that skill and paper badge", () => {
  const reading = result("reading", "reading-1");
  const profile = { visited: [], results: [reading] };

  assert.equal(moduleNeedsNewBadge(profile, "reading"), false);
  assert.equal(moduleNeedsNewBadge(profile, "listening"), true);
  assert.equal(paperNeedsNewBadge(profile.results, "reading-1"), false);
  assert.equal(paperNeedsNewBadge(profile.results, "reading-2"), true);
});

test("AI feedback results retire Writing and Speaking badges", () => {
  const profile = {
    results: [result("writing", "task-1"), result("speaking", "mock-speaking")],
  };
  assert.equal(moduleNeedsNewBadge(profile, "writing"), false);
  assert.equal(moduleNeedsNewBadge(profile, "speaking"), false);
});

test("a drill stays New until its full run records a score", () => {
  assert.equal(drillNeedsNewBadge({}, "articles"), true);
  assert.equal(
    drillNeedsNewBadge(
      { articles: { correct: 6, total: 8, at: "2026-08-12T00:00:00.000Z" } },
      "articles",
    ),
    false,
  );
});

test("a study-section badge retires after it is opened or one topic is completed", () => {
  const scores = {
    articles: { correct: 6, total: 8, at: "2026-08-12T00:00:00.000Z" },
  };
  assert.equal(drillSectionNeedsNewBadge({ visited: [] }, scores, "grammar"), false);
  assert.equal(drillSectionNeedsNewBadge({ visited: ["vocabulary"] }, scores, "vocabulary"), false);
  assert.equal(drillSectionNeedsNewBadge({ visited: [] }, {}, "vocabulary"), true);
});

test("the compact dashboard topic index matches both authored drill banks", () => {
  for (const kind of ["grammar", "vocabulary"]) {
    const data = JSON.parse(
      readFileSync(join(process.cwd(), "data", `${kind}.json`), "utf8"),
    );
    assert.deepEqual(
      [...DRILL_TOPIC_IDS[kind]].sort(),
      data.topics.map((topic) => topic.id).sort(),
    );
  }
});
