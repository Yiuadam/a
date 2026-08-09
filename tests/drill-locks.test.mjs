/*
  Which grammar and vocabulary topics a tier can open, and which one it gets.

  Two separate claims, and they fail in different ways:

  1. The count. A visitor gets one topic per list, a free account two, a
     subscriber all of them. Getting this wrong is visible immediately.

  2. Which one. The free topic must be a *medium* one — the owner asked for
     that specifically, and it is the right ask: a visitor handed the A2 topic
     concludes the app is beneath them, and one handed the C1 topic concludes
     it is beyond them. This is the half that can rot silently, because
     reordering a data file changes the answer and nothing else complains.
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

test("a free account gets two, and both are the middle of the range", () => {
  assert.equal(drillLimit("free"), 2);
  for (const [name, topics] of LISTS) {
    const open = orderTopics(topics, "free").slice(0, 2);
    assert.equal(open.length, 2, name);
    for (const t of open) {
      assert.ok(["B1", "B2"].includes(t.level), `${name}: ${t.id} is ${t.level}`);
    }
  }
});

test("a subscriber has no limit and sees the authored order untouched", () => {
  for (const tier of ["pro", "admin"]) {
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

test("a lock sends a visitor to sign in and everyone else to the plans", () => {
  assert.equal(drillLockReason("anonymous"), "sign-in");
  assert.equal(drillLockReason("free"), "subscribe");
});

/*
  A list shorter than the allowance must not be reordered into nonsense, and a
  list with no B1 at all must still resolve. Both are hypothetical today and
  both are one data edit away.
*/
test("degenerate lists still resolve", () => {
  assert.deepEqual(orderTopics([], "anonymous"), []);
  const noB1 = [
    { id: "a", level: "C1", title: "a" },
    { id: "b", level: "A2", title: "b" },
  ];
  assert.equal(orderTopics(noB1, "anonymous")[0].id, "b", "A2 is nearer the middle than C1");
});
