/*
  Which grammar and vocabulary topics a tier can open, and which one it gets.

  Two separate claims, and they fail in different ways:

  1. The count. A visitor gets one topic per list; everyone with an account —
     free or paid — gets all of them. Getting this wrong is visible
     immediately.

  2. Which one, for the visitor who still has a count at all. The free topic
     must be a *medium* one — the owner asked for that specifically, and it
     is the right ask: a visitor handed the A2 topic concludes the app is
     beneath them, and one handed the C1 topic concludes it is beyond them.
     This is the half that can rot silently, because reordering a data file
     changes the answer and nothing else complains.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const { DRILL_LIMITS, drillLimit, drillLockReason, orderTopics } = await import(
  pathToFileURL(join(process.cwd(), "lib", "entitlements", "drills.ts")).href
);

const grammar = JSON.parse(
  await (await import("node:fs/promises")).readFile(join(process.cwd(), "data", "grammar.json"), "utf8"),
).topics;
const vocabulary = JSON.parse(
  await (await import("node:fs/promises")).readFile(join(process.cwd(), "data", "vocabulary.json"), "utf8"),
).topics;

const LISTS = [
  ["grammar", grammar],
  ["vocabulary", vocabulary],
];

test("a visitor gets exactly one topic in each list", () => {
  assert.equal(drillLimit("anonymous"), 1);
  for (const [name, topics] of LISTS) {
    const ordered = orderTopics(topics, "anonymous");
    assert.equal(ordered.length, topics.length, `${name}: nothing may be hidden, only locked`);
  }
});

test("the one a visitor gets is a medium topic", () => {
  for (const [name, topics] of LISTS) {
    const first = orderTopics(topics, "anonymous")[0];
    assert.equal(first.level, "B1", `${name}: the free topic should be B1, not ${first.level}`);
  }
});

test("every signed-in tier has no limit and sees the authored order untouched", () => {
  for (const tier of ["free", "tracking", "ai", "admin"]) {
    assert.equal(drillLimit(tier), null, tier);
    for (const [name, topics] of LISTS) {
      assert.deepEqual(
        orderTopics(topics, tier).map((t) => t.id),
        topics.map((t) => t.id),
        `${name} @ ${tier}`,
      );
    }
  }
});

test("nothing is dropped or duplicated by the reordering", () => {
  for (const tier of Object.keys(DRILL_LIMITS)) {
    for (const [name, topics] of LISTS) {
      const ids = orderTopics(topics, tier).map((t) => t.id);
      assert.equal(new Set(ids).size, ids.length, `${name} @ ${tier}: duplicate`);
      assert.deepEqual([...ids].sort(), topics.map((t) => t.id).sort(), `${name} @ ${tier}`);
    }
  }
});

test("a lock sends a visitor to sign in", () => {
  assert.equal(drillLockReason("anonymous"), "sign-in");
  /*
    Every signed-in tier has an unlimited drillLimit now, so a locked drill
    card never actually reaches a signed-in learner — nothing in the app asks
    drillLockReason for "free" or above. The function still has to answer if
    asked directly, though, and "subscribe" is the answer the type promises,
    so it is worth pinning down even though nothing calls it today.
  */
  for (const tier of ["free", "tracking", "ai", "admin"]) {
    assert.equal(drillLockReason(tier), "subscribe", `${tier}: asked directly, should not say "sign-in"`);
  }
});

/*
  A list shorter than the allowance — or exactly at it — must not be
  reordered into nonsense, and must come back as the very same array:
  nothing to promote means nothing to rebuild either. A list with no B1 at
  all must still resolve, and a topic whose level is not one of the six CEFR
  levels (corrupt data, a typo in a content file) must rank behind every real
  level rather than win the free slot ahead of an actual medium topic. All
  four are hypothetical today and each is one data edit away.
*/
test("degenerate lists still resolve", () => {
  const empty = [];
  assert.strictEqual(orderTopics(empty, "anonymous"), empty, "nothing to reorder, so the same array back");

  const exactlyAtLimit = [{ id: "only", level: "C1", title: "only" }];
  assert.strictEqual(
    orderTopics(exactlyAtLimit, "anonymous"),
    exactlyAtLimit,
    "a list no longer than the allowance needs no reordering either",
  );

  const noB1 = [
    { id: "a", level: "C1", title: "a" },
    { id: "b", level: "A2", title: "b" },
  ];
  assert.equal(orderTopics(noB1, "anonymous")[0].id, "b", "A2 is nearer the middle than C1");

  const corruptLevel = [
    { id: "corrupt", level: "not-a-level", title: "corrupt" },
    { id: "b1", level: "B1", title: "b1" },
  ];
  assert.equal(
    orderTopics(corruptLevel, "anonymous")[0].id,
    "b1",
    "an unrecognised level must rank last, not win the free slot",
  );
});

/*
  With a limit, only the topics that make the cut are pulled to the front and
  sorted by how close to medium they are — the ones that do not make it stay
  exactly where they were authored. A check that only looks at which topic
  gets the free slot would not notice the rest getting fully re-sorted by
  level instead of left alone; this looks at where everything else lands
  too.
*/
test("only the free slot is promoted — the rest keep their authored order", () => {
  const topics = [
    { id: "c1", level: "C1", title: "c1" },
    { id: "b1", level: "B1", title: "b1" },
    { id: "a2", level: "A2", title: "a2" },
  ];
  assert.deepEqual(
    orderTopics(topics, "anonymous").map((t) => t.id),
    ["b1", "c1", "a2"],
    "b1 is promoted; c1 and a2 stay in authored order, not resorted by level",
  );
});

/*
  Two topics at the same level are a tie, and a stable sort breaks a tie by
  authored order. Losing that tie-break would still often pick a winner —
  just not reliably the one an author would expect — so this pins the
  earlier-authored topic as the one that should win the only open slot.
*/
test("a tie between same-level topics favours whichever was authored first", () => {
  const tied = [
    { id: "first", level: "B1", title: "first" },
    { id: "second", level: "B1", title: "second" },
  ];
  assert.equal(
    orderTopics(tied, "anonymous")[0].id,
    "first",
    "same level, so the earlier-authored topic should win the only open slot",
  );
});
