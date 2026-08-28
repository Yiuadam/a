import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);
const readiness = await load("lib", "cloudflare", "migration-readiness.ts");
const cutoverDomains = await load("lib", "cloudflare", "cutover-domains.ts");

/*
  A comment quoting the code it checks once made an assertion pass against
  nothing at all. Source text is therefore stripped of comments before
  anything is asserted about it.
*/
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((row) => row.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

function runtimeD1(database) {
  const bound = (sql, values) => ({
    async run() {
      const result = database.prepare(sql).run(...values);
      return { success: true, results: [], meta: { changes: Number(result.changes ?? 0) } };
    },
    async first(column) {
      const row = database.prepare(sql).get(...values) ?? null;
      return column && row ? row[column] ?? null : row;
    },
    async all() {
      return { success: true, results: database.prepare(sql).all(...values), meta: {} };
    },
  });
  return {
    prepare(sql) {
      return { bind: (...values) => bound(sql, values), ...bound(sql, []) };
    },
  };
}

function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(process.cwd(), "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "cloudflare", "migrations", file), "utf8"));
  }
  return { database, bindings: { db: runtimeD1(database), files: {} } };
}

const USER = "50000000-0000-4000-8000-000000000099";
const CREATED = "2026-08-01T00:00:00.000Z";
const UPDATED = "2026-08-14T10:00:00.000Z";

function seedTarget(database) {
  database.prepare(`
    INSERT INTO app_users (id,email,role,created_at,updated_at)
    VALUES (?, 'parity@example.test', 'user', ?, ?)
  `).run(USER, CREATED, UPDATED);
  database.prepare(`
    INSERT INTO learner_profiles (user_id,display_name,source_updated_at,updated_at)
    VALUES (?, 'Parity Learner', ?, ?)
  `).run(USER, UPDATED, UPDATED);
  database.prepare(`
    INSERT INTO usernames (username,user_id,created_at,source_updated_at)
    VALUES ('parity.learner', ?, ?, ?)
  `).run(USER, CREATED, UPDATED);
  database.prepare(`
    INSERT INTO progress_snapshots (
      user_id,store_key,payload_inline,payload_sha256,payload_bytes,
      source_updated_at,created_at,updated_at
    ) VALUES (?, 'ielts-prep-v1', '{}', ?, 2, ?, ?, ?)
  `).run(USER, createHash("sha256").update("{}").digest("hex"), UPDATED, CREATED, UPDATED);
  database.prepare(`
    INSERT INTO subscriptions (
      id,user_id,provider,status,tier,verified_at,created_at,updated_at
    ) VALUES ('subscription-1', ?, 'stripe', 'active', 'pro', ?, ?, ?)
  `).run(USER, UPDATED, CREATED, UPDATED);
  database.prepare(`
    INSERT INTO provider_events (provider,event_id,received_at,processed_at)
    VALUES ('stripe', 'event-1', ?, ?)
  `).run(CREATED, UPDATED);
  database.prepare(`
    INSERT INTO usage_events (id,user_id,route,outcome,created_at)
    VALUES ('901', ?, 'define', 'admitted', ?)
  `).run(USER, UPDATED);
  database.prepare(`
    INSERT INTO ai_cost_events (
      id,source,external_reference,cost_usd,occurred_at,recorded_at
    ) VALUES ('902', 'provider_backfill', 'parity-backfill', '0.123456789', ?, ?)
  `).run(CREATED, UPDATED);
  database.prepare(`
    INSERT INTO ai_cost_coverage (
      singleton,source,starts_at,historical_complete,recorded_at
    ) VALUES (1, 'provider_console', ?, 1, ?)
  `).run(CREATED, UPDATED);
}

function appSettingsReady() {
  return {
    generatedAt: UPDATED,
    authority: "supabase",
    mode: "dual",
    readyForAppSettingsCutover: true,
    items: [
      { key: "maintenance", status: "absent", sourceUpdatedAt: null, targetUpdatedAt: null },
      { key: "maintenance_dispatch", status: "absent", sourceUpdatedAt: null, targetUpdatedAt: null },
    ],
  };
}

const EMPTY_OUTBOX = {
  pending: 0,
  dead: 0,
  oldestPendingAt: null,
  cleanupPending: 0,
  cleanupDead: 0,
};

async function withModes(run) {
  const learner = process.env.CLOUDFLARE_DATA_MODE;
  const organization = process.env.ORGANIZATION_DATA_MODE;
  process.env.CLOUDFLARE_DATA_MODE = "dual";
  process.env.ORGANIZATION_DATA_MODE = "cloudflare";
  try {
    return await run();
  } finally {
    if (learner === undefined) delete process.env.CLOUDFLARE_DATA_MODE;
    else process.env.CLOUDFLARE_DATA_MODE = learner;
    if (organization === undefined) delete process.env.ORGANIZATION_DATA_MODE;
    else process.env.ORGANIZATION_DATA_MODE = organization;
  }
}

test("the global report proves exact identities and versions but fails closed on runtime gaps", async () => {
  const context = fixture();
  seedTarget(context.database);
  const source = await readiness.cloudflareTargetFingerprints(context.bindings);
  const profile = source.find((row) => row.domain === "profiles");
  assert.equal(profile.row_count, 1);
  assert.equal(
    profile.fingerprint,
    createHash("sha256").update(
      `36:${USER}|19:parity@example.test|4:user|14:Parity Learner|-:|-:`,
    ).digest("hex"),
  );

  const report = await withModes(() => readiness.cloudflareMigrationReadinessReport(
    context.bindings,
    {
      readSourceFingerprints: async () => source,
      readAppSettings: async () => appSettingsReady(),
      readOutbox: async () => EMPTY_OUTBOX,
    },
  ));

  assert.equal(report.domains.slice(0, 8).every((domain) => domain.status === "equal"), true);
  assert.equal(report.sourceEvidence.status, "available");
  assert.equal(report.domains.find((domain) => domain.domain === "organizations").status, "authoritative");
  assert.equal(report.supabaseAuth.included, false);
  assert.equal(report.supabaseAuth.authority, "supabase");
  assert.equal(report.readyForCloudflareOnly, false);
  // Billing entitlement reads are D1-capable, but payment mutations are not
  // native yet; a Cloudflare-only report must name that rather than calling
  // the source writer complete.
  assert.ok(report.unsupportedDomains.includes("billing_entitlement_runtime"));
  assert.ok(!report.unsupportedDomains.includes("usage_quota_authority"));
  assert.ok(!report.unsupportedDomains.includes("ai_cost_write_authority"));
  assert.ok(report.unsupportedDomains.includes("cutover_write_barrier"));
  assert.ok(report.blockers.includes("unsupported application-data domains remain"));

  // unsupportedDomains is derived from the cutover-domain registry rather
  // than hard-coded here: with organizations and app settings both reported
  // ready in this fixture, the registry's ten domains are exactly what
  // remains unsupported — nothing more, nothing less.
  assert.deepEqual(
    [...report.unsupportedDomains].sort(),
    [...cutoverDomains.unsupportedCutoverDomains()].sort(),
  );
});

test("a source-target mismatch and non-empty replica queues are named as blockers", async () => {
  const context = fixture();
  seedTarget(context.database);
  const source = await readiness.cloudflareTargetFingerprints(context.bindings);
  const changed = source.map((row) => row.domain === "usage_events"
    ? { ...row, row_count: row.row_count + 1, fingerprint: "a".repeat(64) }
    : row);
  const report = await withModes(() => readiness.cloudflareMigrationReadinessReport(
    context.bindings,
    {
      readSourceFingerprints: async () => changed,
      readAppSettings: async () => appSettingsReady(),
      readOutbox: async () => ({
        pending: 2,
        dead: 1,
        oldestPendingAt: CREATED,
        cleanupPending: 3,
        cleanupDead: 4,
      }),
    },
  ));
  const usage = report.domains.find((domain) => domain.domain === "usage_events");
  assert.equal(usage.status, "source_only");
  assert.equal(usage.ready, false);
  assert.ok(report.blockers.includes("replica_outbox: 2 pending"));
  assert.ok(report.blockers.includes("replica_outbox: 1 dead"));
  assert.ok(report.blockers.includes("replica_object_cleanup: 3 pending"));
  assert.ok(report.blockers.includes("replica_object_cleanup: 4 dead"));
});

test("missing, duplicate or malformed source evidence is unavailable rather than optimistic", async () => {
  const context = fixture();
  seedTarget(context.database);
  const source = await readiness.cloudflareTargetFingerprints(context.bindings);
  const malformed = [...source.slice(0, -1), source[0]];
  malformed[0] = { ...malformed[0], fingerprint: "not-a-sha" };
  const report = await withModes(() => readiness.cloudflareMigrationReadinessReport(
    context.bindings,
    {
      readSourceFingerprints: async () => malformed,
      readAppSettings: async () => appSettingsReady(),
      readOutbox: async () => EMPTY_OUTBOX,
    },
  ));
  assert.equal(report.domains.slice(0, 8).every((domain) => domain.status === "unavailable"), true);
  assert.equal(report.sourceEvidence.status, "invalid");
  assert.equal(report.readyForCloudflareOnly, false);
});

test("an unreadable source fingerprint RPC is named without exposing source rows or error text", async () => {
  const context = fixture();
  seedTarget(context.database);
  const report = await withModes(() => readiness.cloudflareMigrationReadinessReport(
    context.bindings,
    {
      readSourceFingerprints: async () => { throw new Error("source database detail must stay server-only"); },
      readAppSettings: async () => appSettingsReady(),
      readOutbox: async () => EMPTY_OUTBOX,
    },
  ));

  assert.equal(report.sourceEvidence.status, "unavailable");
  assert.equal(report.domains.slice(0, 8).every((domain) => domain.status === "unavailable"), true);
  assert.doesNotMatch(JSON.stringify(report), /source database detail must stay server-only/);
});

test("the source RPC and API expose migration evidence only to the owner service path", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase", "migrations", "0029_cloudflare_migration_readiness.sql"),
    "utf8",
  );
  const route = readFileSync(
    join(process.cwd(), "app", "api", "admin", "cloudflare", "readiness", "route.ts"),
    "utf8",
  );
  const ui = readFileSync(
    join(process.cwd(), "components", "admin", "CloudflareMigrationReadiness.tsx"),
    "utf8",
  );

  assert.match(sql, /security definer/);
  assert.match(sql, /revoke all[\s\S]*from public, anon, authenticated/);
  assert.match(sql, /grant execute[\s\S]*to service_role/);
  assert.doesNotMatch(sql, /auth\.users/);
  assert.doesNotMatch(sql, /select[\s\S]{0,100}\bemail\b/i);
  assert.match(route, /isAdminEmail\(actor\.email\)/);
  assert.match(route, /private, no-store/);
  assert.match(ui, /Supabase Auth is deliberately excluded/);
  assert.match(ui, /Cloudflare-native sign-in is active/);
  assert.match(ui, /Cloudflare-only readiness/);
  assert.match(ui, /Supabase fingerprint evidence/);
  assert.match(ui, /migration 0029/);
  assert.match(ui, /Cutover blockers/);
  assert.match(ui, /cleanupDead/);
});

test("the report distinguishes an active native Cloudflare identity authority from legacy Supabase compatibility", async () => {
  const context = fixture();
  seedTarget(context.database);
  const source = await readiness.cloudflareTargetFingerprints(context.bindings);
  const saved = {
    native: process.env.CLOUDFLARE_NATIVE_AUTH,
    learner: process.env.CLOUDFLARE_DATA_MODE,
    organization: process.env.ORGANIZATION_DATA_MODE,
  };
  process.env.CLOUDFLARE_NATIVE_AUTH = "1";
  process.env.CLOUDFLARE_DATA_MODE = "cloudflare";
  process.env.ORGANIZATION_DATA_MODE = "cloudflare";
  try {
    const report = await readiness.cloudflareMigrationReadinessReport(context.bindings, {
      readSourceFingerprints: async () => source,
      readAppSettings: async () => appSettingsReady(),
      readOutbox: async () => EMPTY_OUTBOX,
    });
    assert.equal(report.supabaseAuth.authority, "cloudflare");
    assert.match(report.supabaseAuth.reason, /temporary legacy-session bridge/);
  } finally {
    for (const [key, value] of Object.entries({
      CLOUDFLARE_NATIVE_AUTH: saved.native,
      CLOUDFLARE_DATA_MODE: saved.learner,
      ORGANIZATION_DATA_MODE: saved.organization,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a retired Supabase source is shown as historical, not as a live mismatch", async () => {
  const context = fixture();
  seedTarget(context.database);
  const saved = Object.fromEntries([
    "CLOUDFLARE_NATIVE_AUTH",
    "CLOUDFLARE_DATA_MODE",
    "ORGANIZATION_DATA_MODE",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ].map((key) => [key, process.env[key]]));
  process.env.CLOUDFLARE_NATIVE_AUTH = "1";
  process.env.CLOUDFLARE_DATA_MODE = "cloudflare";
  process.env.ORGANIZATION_DATA_MODE = "cloudflare";
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  let sourceRead = false;
  try {
    const report = await readiness.cloudflareMigrationReadinessReport(context.bindings, {
      readSourceFingerprints: async () => {
        sourceRead = true;
        throw new Error("retired source must not be contacted");
      },
      readOutbox: async () => EMPTY_OUTBOX,
    });
    assert.equal(sourceRead, false);
    assert.equal(report.sourceEvidence.status, "retired");
    assert.equal(report.domains.slice(0, 8).every((domain) => domain.status === "authoritative"), true);
    assert.ok(report.blockers.includes("source_parity: retired after cutover; historical comparison is no longer available"));
    assert.equal(report.blockers.some((item) => /profiles: authoritative/.test(item)), false);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a missing AVATAR_URL_SIGNING_KEY is named as a blocker even when every domain is otherwise equal", async () => {
  const context = fixture();
  seedTarget(context.database);
  const source = await readiness.cloudflareTargetFingerprints(context.bindings);
  const secret = process.env.AVATAR_URL_SIGNING_KEY;
  delete process.env.AVATAR_URL_SIGNING_KEY;
  try {
    const report = await withModes(() => readiness.cloudflareMigrationReadinessReport(
      context.bindings,
      {
        readSourceFingerprints: async () => source,
        readAppSettings: async () => appSettingsReady(),
        readOutbox: async () => EMPTY_OUTBOX,
      },
    ));
    assert.ok(report.blockers.includes("avatar_delivery: AVATAR_URL_SIGNING_KEY is not configured"));
    assert.equal(report.readyForCloudflareOnly, false);
  } finally {
    if (secret === undefined) delete process.env.AVATAR_URL_SIGNING_KEY;
    else process.env.AVATAR_URL_SIGNING_KEY = secret;
  }
});

test("a configured AVATAR_URL_SIGNING_KEY does not itself block readiness", async () => {
  const context = fixture();
  seedTarget(context.database);
  const source = await readiness.cloudflareTargetFingerprints(context.bindings);
  const secret = process.env.AVATAR_URL_SIGNING_KEY;
  process.env.AVATAR_URL_SIGNING_KEY = "test-signing-key-for-readiness-fixture";
  try {
    const report = await withModes(() => readiness.cloudflareMigrationReadinessReport(
      context.bindings,
      {
        readSourceFingerprints: async () => source,
        readAppSettings: async () => appSettingsReady(),
        readOutbox: async () => EMPTY_OUTBOX,
      },
    ));
    assert.ok(!report.blockers.includes("avatar_delivery: AVATAR_URL_SIGNING_KEY is not configured"));
  } finally {
    if (secret === undefined) delete process.env.AVATAR_URL_SIGNING_KEY;
    else process.env.AVATAR_URL_SIGNING_KEY = secret;
  }
});

test("unsupportedDomains is derived from the cutover-domain registry, not a literal list here", () => {
  const source = code(readFileSync(
    join(process.cwd(), "lib", "cloudflare", "migration-readiness.ts"),
    "utf8",
  ));
  assert.match(source, /unsupportedDomains\.push\(\.\.\.unsupportedCutoverDomains\(\)\)/);
  // None of the ten domain names may still be spelled out as string literals
  // in this file — a stage that finishes one flips `supported` in
  // cutover-domains.ts instead of editing this list.
  for (const domain of cutoverDomains.CUTOVER_DOMAINS.map((entry) => entry.domain)) {
    assert.doesNotMatch(source, new RegExp(`"${domain}"`));
  }
});
