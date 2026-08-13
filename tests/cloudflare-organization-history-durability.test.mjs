import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);
const attemptSync = await load("lib", "organizations", "attempt-sync.ts");
const objectCleanup = await load("lib", "cloudflare", "organization-attempt-objects.ts");

const USER = "499f408e-a012-48a0-ab0d-7aa1f7ca103b";
const OLD_OBJECT = `private/attempts/${USER}/${"a".repeat(64)}.json`;

test("history-clear watermarks are normalized and attempt extraction remains bounded", () => {
  assert.equal(
    attemptSync.organizationHistoryClearWatermark({
      historyClearedAt: "2026-08-13T12:34:56+08:00",
    }),
    "2026-08-13T04:34:56.000Z",
  );
  assert.equal(attemptSync.organizationHistoryClearWatermark({ historyClearedAt: "nonsense" }), null);
  const attempts = Array.from({ length: 120 }, (_, index) => ({
    module: "reading",
    testId: `paper-${index}`,
    testTitle: `Paper ${index}`,
    band: 7,
    date: `2026-08-13T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
  }));
  assert.equal(attemptSync.organizationAttempts(attempts).length, 100);
  assert.equal(
    attemptSync.organizationAttempts([{
      module: "reading",
      testId: "offset-paper",
      testTitle: "Offset paper",
      band: 7,
      date: "2026-08-13T12:34:56+08:00",
    }])[0].date,
    "2026-08-13T04:34:56.000Z",
  );
});

test("review metadata distinguishes a real detailed review from score-only resync", () => {
  const score = {
    module: "writing",
    testId: "writing-1",
    testTitle: "Writing",
    band: 7,
    date: "2026-08-13T00:00:00.000Z",
  };
  assert.equal(attemptSync.organizationAttemptHasReview(score), false);
  assert.equal(attemptSync.organizationAttemptHasReview({
    ...score,
    review: { kind: "writing", task: "essay", feedback: "detailed" },
  }), true);
});

test("object retirement never deletes a key still referenced by an attempt or outbox", async () => {
  const deleted = [];
  const cleanupDeletes = [];
  const bindings = {
    db: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              async all() {
                if (sql.includes("SELECT result_object_key AS object_key")) {
                  return { results: [{ object_key: OLD_OBJECT }] };
                }
                return { results: [] };
              },
              async run() {
                if (sql.includes("DELETE FROM organization_attempt_object_cleanup")) {
                  cleanupDeletes.push(...values);
                }
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
      async batch() {
        return [];
      },
    },
    files: {
      async delete(keys) {
        deleted.push(...(Array.isArray(keys) ? keys : [keys]));
      },
    },
  };
  assert.equal(
    await objectCleanup.retireOrganizationAttemptObjects(bindings, USER, [OLD_OBJECT]),
    true,
  );
  assert.deepEqual(deleted, []);
  assert.deepEqual(cleanupDeletes, [OLD_OBJECT]);
});

test("an orphan is deleted only after the reference check", async () => {
  const events = [];
  const bindings = {
    db: {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                events.push("references");
                return { results: [] };
              },
              async run() {
                events.push("forget");
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
      async batch() {
        events.push("queue");
        return [];
      },
    },
    files: {
      async delete() {
        events.push("r2-delete");
      },
    },
  };
  assert.equal(
    await objectCleanup.retireOrganizationAttemptObjects(bindings, USER, [OLD_OBJECT]),
    true,
  );
  assert.deepEqual(events, ["references", "r2-delete", "forget"]);
});

test("R2 deletion failure is converted into durable bounded cleanup work", async () => {
  const events = [];
  const bindings = {
    db: {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                events.push("references");
                return { results: [] };
              },
            };
          },
        };
      },
      async batch(statements) {
        events.push(`queued:${statements.length}`);
        return [];
      },
    },
    files: {
      async delete() {
        events.push("r2-failed");
        throw new Error("temporary R2 failure");
      },
    },
  };
  assert.equal(
    await objectCleanup.retireOrganizationAttemptObjects(bindings, USER, [OLD_OBJECT]),
    false,
  );
  assert.deepEqual(events, ["references", "r2-failed", "queued:1"]);
});

test("migration and runtime pin watermarks, R2 review preservation and a coalescing outbox", () => {
  const migration = readFileSync(
    join(process.cwd(), "cloudflare/migrations/0006_organization_history_durability.sql"),
    "utf8",
  );
  const organizations = readFileSync(join(process.cwd(), "lib/cloudflare/organizations.ts"), "utf8");
  const outbox = readFileSync(
    join(process.cwd(), "lib/cloudflare/organization-attempt-outbox.ts"),
    "utf8",
  );
  const progress = readFileSync(join(process.cwd(), "app/api/account/progress/route.ts"), "utf8");

  assert.match(migration, /result_has_review/);
  assert.match(migration, /organization_history_clear_watermarks/);
  assert.match(migration, /organization_attempt_sync_outbox[\s\S]*user_id TEXT PRIMARY KEY/);
  assert.match(migration, /attempt_count INTEGER NOT NULL CHECK \(attempt_count BETWEEN 0 AND 100\)/);
  assert.match(migration, /attempts_made INTEGER NOT NULL DEFAULT 0 CHECK \(attempts_made BETWEEN 0 AND 20\)/);
  assert.match(migration, /practice_attempt_result_object_cleanup_update/);
  assert.match(migration, /practice_attempt_result_object_cleanup_delete/);
  assert.match(migration, /organization_attempt_outbox_object_cleanup_update/);
  assert.match(migration, /organization_attempt_outbox_object_cleanup_delete/);
  assert.match(organizations, /practice_attempts\.result_has_review = 1 AND excluded\.result_has_review = 0/);
  assert.doesNotMatch(organizations, /result_inline LIKE '%\\?"review/);
  assert.match(organizations, /DELETE FROM practice_attempts[\s\S]*organization_history_clear_watermarks/);
  assert.match(organizations, /julianday\(cleared_at\) >= julianday\(excluded\.submitted_at\)/);
  assert.match(organizations, /SELECT response_json, request_hash FROM organization_sync_receipts/);
  assert.match(organizations, /existing\.request_hash !== requestHash/);
  assert.match(organizations, /request_hash, response_json/);
  assert.doesNotMatch(organizations, /existingAttemptObjectKeys/);
  assert.match(outbox, /ON CONFLICT\(user_id\) DO UPDATE/);
  assert.match(outbox, /INSERT INTO organization_history_clear_watermarks/);
  assert.match(outbox, /DELETE FROM practice_attempts/);
  assert.match(outbox, /bindings\.db\.batch\(statements\)/);
  assert.match(outbox, /lease_token/);
  assert.match(outbox, /Math\.min\(MAX_DRAIN/);
  assert.match(progress, /enqueueCloudflareOrganizationAttemptSync/);
  assert.match(progress, /const written = acceptedSnapshots\.length[\s\S]*enqueueCloudflareOrganizationAttemptSync/);
  assert.match(progress, /crypto\.randomUUID\(\)/);
  assert.doesNotMatch(progress, /idempotencyKey = `progress:\$\{auth\.user\.id\}:\$\{stamp\}`/);
  assert.match(progress, /primary progress could not be read for organization repair/);
  assert.match(progress, /progress-repair:/);
});
