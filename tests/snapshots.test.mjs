/*
  Snapshot identity for the two device-local stores behind /grammar and
  /vocabulary.

  useSyncExternalStore compares snapshots with Object.is. A getServerSnapshot
  that builds a fresh value every call therefore looks like a store that
  changes on every render, and React logs "The result of getServerSnapshot
  should be cached to avoid an infinite loop" — which is what these pages did
  in production. The property that fixes it is identity, not equality, so that
  is what is asserted here: the same object back, call after call, and the same
  object again from the client snapshot while the store is still empty (the
  state the server rendered).
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const load = (name) =>
  import(pathToFileURL(join(process.cwd(), "lib", `${name}.ts`)).href);

const { drillScores, getServerDrillScores, shuffle } = await load("drills");
const { getServerSavedWords, savedWords } = await load("lookups");
const { getServerSnapshot } = await load("store");

test("getServerDrillScores returns the same object every call", () => {
  assert.equal(getServerDrillScores(), getServerDrillScores());
  assert.deepEqual(getServerDrillScores(), {});
});

test("getServerSavedWords returns the same array every call", () => {
  assert.equal(getServerSavedWords(), getServerSavedWords());
  assert.deepEqual(getServerSavedWords(), []);
});

test("getServerSnapshot returns the same profile every call", () => {
  assert.equal(getServerSnapshot(), getServerSnapshot());
});

/*
  These run without a window, so the client snapshots read as empty — the same
  thing the server render produced. Hydration must not see a change.
*/
test("client snapshots are stable and match the server snapshot when empty", () => {
  assert.equal(drillScores(), drillScores());
  assert.equal(drillScores(), getServerDrillScores());
  assert.equal(savedWords(), savedWords());
  assert.equal(savedWords(), getServerSavedWords());
});

test("shuffle leaves the source array alone and keeps every item", () => {
  const source = ["a", "b", "c", "d"];
  const out = shuffle(source);
  assert.deepEqual(source, ["a", "b", "c", "d"]);
  assert.deepEqual([...out].sort(), ["a", "b", "c", "d"]);
});
