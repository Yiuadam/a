import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const { mergeProgressSnapshotPayload } = await import(pathToFileURL(
  join(process.cwd(), "lib", "progress", "server-snapshots.ts"),
).href);

const result = (testId, date, band, module = "reading") => ({
  module,
  testId,
  testTitle: testId,
  band,
  date,
});

test("a stale second device is merged with the first device on the server", () => {
  const firstCommit = {
    results: [result("reading-first", "2026-08-13T10:00:00.000Z", 7)],
    visited: ["reading"],
  };
  const staleSecondDevice = {
    results: [result("listening-second", "2026-08-13T10:01:00.000Z", 6.5, "listening")],
    visited: ["listening"],
  };

  const merged = mergeProgressSnapshotPayload(
    "ielts-prep-v1",
    staleSecondDevice,
    firstCommit,
    Date.parse("2026-08-13T10:01:00.000Z"),
    Date.parse("2026-08-13T10:00:00.000Z"),
    false,
  );

  assert.deepEqual(merged.results.map((item) => item.testId), [
    "listening-second",
    "reading-first",
  ]);
  assert.deepEqual([...merged.visited].sort(), ["listening", "reading"]);
});

test("server merge covers every progress store", () => {
  const drills = mergeProgressSnapshotPayload(
    "bandup.drills.v1",
    { articles: { correct: 7, total: 8, at: "2026-08-13T10:00:00.000Z" } },
    { modals: { correct: 6, total: 8, at: "2026-08-13T09:00:00.000Z" } },
    0,
    0,
    false,
  );
  assert.deepEqual(Object.keys(drills).sort(), ["articles", "modals"]);

  const lookups = mergeProgressSnapshotPayload(
    "bandup.lookups.v1",
    { band: { definition: "range" } },
    { cohort: { definition: "group" } },
    0,
    0,
    false,
  );
  assert.deepEqual(Object.keys(lookups).sort(), ["band", "cohort"]);
});

test("restricted organization history is still protected during server merge", () => {
  const stored = {
    results: [result("protected", "2026-08-12T10:00:00.000Z", 7)],
    targetBand: 7,
  };
  const merged = mergeProgressSnapshotPayload(
    "ielts-prep-v1",
    { results: [], historyClearedAt: "2026-08-13T10:00:00.000Z", targetBand: 8 },
    stored,
    Date.parse("2026-08-13T10:00:00.000Z"),
    Date.parse("2026-08-12T10:00:00.000Z"),
    true,
  );
  assert.equal(merged.results[0].testId, "protected");
  assert.equal(merged.historyClearedAt, undefined);
  assert.equal(merged.targetBand, 8);
});

test("progress PUT is an all-or-nothing CAS contract", () => {
  const route = readFileSync(
    join(process.cwd(), "app", "api", "account", "progress", "route.ts"),
    "utf8",
  );
  const router = readFileSync(
    join(process.cwd(), "lib", "cloudflare", "data-router.ts"),
    "utf8",
  );
  const cloudflare = readFileSync(
    join(process.cwd(), "lib", "cloudflare", "learner-data.ts"),
    "utf8",
  );
  const migration = readFileSync(
    join(process.cwd(), "supabase", "migrations", "0025_atomic_progress_sync.sql"),
    "utf8",
  );

  assert.match(route, /clientUpdatedAt/);
  assert.match(route, /MAX_COMMIT_ATTEMPTS/);
  assert.match(route, /mergeProgressSnapshotPayload/);
  assert.match(route, /compareAndSwapLearnerProgressSnapshots/);
  assert.doesNotMatch(route, /for \(const entry of snapshots\)[\s\S]*putLearnerProgressSnapshot/);
  assert.match(router, /compareAndSwapProgressSnapshots/);
  assert.match(router, /compareAndSwapCloudflareProgressSnapshots/);
  assert.match(cloudflare, /bindings\.db\.batch/);
  assert.match(cloudflare, /WITH expected/);
  assert.match(cloudflare, /result\.meta\.changes !== snapshots\.length/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /current\.client_updated_at is distinct from/);
  assert.match(migration, /insert into public\.progress_snapshots/);
  assert.match(migration, /grant execute[\s\S]*to service_role/);
});
