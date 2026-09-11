/*
  Progress-sync stopped being free with any account, and three places have to
  agree about that or the promise is fake in one of them: the server route
  that actually reads and writes the synced copy, the client gate in front of
  every history page, and the tier catalogue that says who is allowed to ask.

  This mirrors the shape of tests/speaking-examiner-line.test.mjs and
  tests/billing-tiers.test.mjs — source-string assertions rather than a
  rendered tree, which is what this codebase already does for every other
  client-side gate (SkillGate, TutorChat, WritingSession).
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const tiers = await import(pathToFileURL(join(root, "lib", "billing", "tiers.ts")).href);
const { tierAllows, PROGRESS_SYNC_TIERS } = tiers;

test("progress-sync is Tracking's and AI's, not Free's", () => {
  assert.equal(tierAllows("free", "progress-sync"), false);
  assert.equal(tierAllows("tracking", "progress-sync"), true);
  assert.equal(tierAllows("ai", "progress-sync"), true);
  assert.equal(tierAllows("admin", "progress-sync"), true);
  assert.deepEqual([...PROGRESS_SYNC_TIERS].sort(), ["ai", "tracking"]);
});

test("the sync route actually refuses a tier without it, not just the client", () => {
  const route = read("app", "api", "account", "progress", "route.ts");
  assert.match(route, /import \{ requireFeature \} from "@\/lib\/billing\/gate";/);
  // Both handlers, not just one — a GET that leaked history and a PUT that
  // refused would still leak everything a GET could read back.
  const get = route.slice(route.indexOf("async function handleGET"), route.indexOf("async function handlePUT"));
  const put = route.slice(route.indexOf("async function handlePUT"));
  for (const [name, body] of [["GET", get], ["PUT", put]]) {
    assert.match(
      body,
      /const denied = await requireFeature\(req, "progress-sync"\);\s*\n\s*if \(denied\) return denied;/,
      `${name} does not gate progress-sync`,
    );
  }
});

test("every history page is wrapped in the same gate, not one each", () => {
  const gate = read("components", "history", "HistoryGate.tsx");
  assert.match(gate, /tierShows\(account, "progress-sync"\)/);
  assert.match(gate, /tier="tracking"/);

  for (const file of [
    ["app", "history", "page.tsx"],
    ["app", "history", "lookups", "page.tsx"],
    ["app", "history", "result", "page.tsx"],
  ]) {
    const source = read(...file);
    assert.match(source, /import HistoryGate from "@\/components\/history\/HistoryGate";/, file.join("/"));
    assert.match(source, /<HistoryGate>/, file.join("/"));
  }
});

test("a sync a Free account cannot make is a named outcome, not a bare failure", () => {
  const sync = read("lib", "progress", "sync.ts");
  assert.match(sync, /\| \{ status: "not-entitled" \}/);
  assert.match(sync, /if \(res\.status === 402\) return \{ status: "not-entitled" \};/);
  // Both fetch sites — the read in step 1 and the write in step 3 — or a
  // device that could read a 402 but not write one would retry forever on
  // the half that never got the memo.
  assert.equal(
    (sync.match(/if \(res\.status === 402\) return \{ status: "not-entitled" \};/g) ?? []).length,
    2,
    "expected both the GET and the PUT to check for 402",
  );
  // Treated like signed-out, not like an outage: retrying a 402 wastes
  // requests relearning a fact the client already has.
  assert.match(sync, /outcome\.status === "signed-out" \|\|\s*\n\s*outcome\.status === "not-entitled"/);

  const autosync = read("lib", "progress", "autosync.ts");
  assert.match(
    autosync,
    /outcome\.status === "signed-out" \|\| outcome\.status === "not-entitled"\) cancelScheduledSync\(\);/,
  );
});

test("clearing a device does not ask the server to clear a copy Free never had", () => {
  const section = read("components", "account", "ClearDeviceSection.tsx");
  assert.match(section, /tierShows\(tier, "progress-sync"\)/);
  // The network call is skipped for exactly this reason — a Free account has
  // nothing synced to reconcile, so asking would only turn a no-op into a
  // 402 the reader has to be told is not really a failure.
  assert.match(section, /if \(session && hasSync\) \{/);
});
