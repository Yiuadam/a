import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { SUPABASE_STUB } from "./supabase-stub.mjs";

register("./alias-resolve.mjs", import.meta.url);

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");
const AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const effectiveAccess = await import(
  pathToFileURL(join(process.cwd(), "lib", "admin", "effective-access.ts")).href
);
const userProgress = await import(
  pathToFileURL(join(process.cwd(), "lib", "admin", "user-progress.ts")).href
);
const sittingKey = await import(
  pathToFileURL(join(process.cwd(), "lib", "admin", "sitting-key.ts")).href
);
const organizationAccess = await import(
  pathToFileURL(join(process.cwd(), "lib", "cloudflare", "admin-organization-access.ts")).href
);

function runtimeD1(database) {
  const bound = (sql, values) => ({
    async all() { return { success: true, results: database.prepare(sql).all(...values), meta: {} }; },
  });
  return { prepare(sql) { return { bind: (...values) => bound(sql, values) }; } };
}

function findPostgresBin() {
  const base = "/usr/lib/postgresql";
  if (!existsSync(base)) return null;
  for (const version of readdirSync(base).filter((value) => /^\d+$/.test(value)).sort((a, b) => Number(b) - Number(a))) {
    const bin = join(base, version, "bin");
    if (existsSync(join(bin, "initdb")) && existsSync(join(bin, "psql"))) return bin;
  }
  return null;
}

function runner(bin, dir) {
  return (command, args, options = {}) => {
    const executable = join(bin, command);
    const base = { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], cwd: dir, ...options };
    return AS_ROOT
      ? execFileSync("runuser", ["-u", "postgres", "--", executable, ...args], base)
      : execFileSync(executable, args, base);
  };
}

function provision() {
  const bin = findPostgresBin();
  if (!bin) return { skip: "no PostgreSQL installation found under /usr/lib/postgresql" };
  if (AS_ROOT) {
    try { execFileSync("id", ["postgres"], { stdio: "ignore" }); }
    catch { return { skip: "running as root with no postgres account" }; }
  }
  const dir = mkdtempSync(join(tmpdir(), "bandup-admin-entitlement-pg-"));
  const data = join(dir, "data");
  const socket = join(dir, "sock");
  try {
    execFileSync("mkdir", ["-p", socket]);
    if (AS_ROOT) execFileSync("chown", ["-R", "postgres:postgres", dir]);
    const run = runner(bin, dir);
    run("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
    run("pg_ctl", ["-D", data, "-o", `-p 5432 -k ${socket} -c listen_addresses='' -c fsync=off`, "-w", "-l", join(dir, "log"), "start"]);
    const psql = (sql) => run("psql", ["-h", socket, "-p", "5432", "-U", "postgres", "-d", "postgres", "-tAq", "-v", "ON_ERROR_STOP=1", "-c", sql]).trim();
    const psqlFile = (file) => run("psql", ["-h", socket, "-p", "5432", "-U", "postgres", "-d", "postgres", "-q", "-v", "ON_ERROR_STOP=1", "-f", file]);
    return { dir, data, run, psql, psqlFile };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    return { skip: `could not start a cluster (${error instanceof Error ? error.message.split("\n")[0] : error})` };
  }
}

function teardown(pg) {
  try { pg.run("pg_ctl", ["-D", pg.data, "-m", "immediate", "-w", "stop"]); } catch { /* already stopped */ }
  rmSync(pg.dir, { recursive: true, force: true });
}

test("admin entitlement SQL uses the gate's effective tier and keeps organisation seats separate", async (t) => {
  const pg = provision();
  if (pg.skip) {
    t.diagnostic(`skipped: ${pg.skip}`);
    return;
  }
  try {
    const stub = join(pg.dir, "stub.sql");
    execFileSync("tee", [stub], { input: SUPABASE_STUB, stdio: ["pipe", "ignore", "ignore"] });
    if (AS_ROOT) execFileSync("chown", ["postgres:postgres", stub]);
    pg.psqlFile(stub);
    for (const name of readdirSync(MIGRATIONS).filter((value) => value.endsWith(".sql")).sort()) {
      const copy = join(pg.dir, name);
      execFileSync("tee", [copy], { input: readFileSync(join(MIGRATIONS, name)), stdio: ["pipe", "ignore", "ignore"] });
      if (AS_ROOT) execFileSync("chown", ["postgres:postgres", copy]);
      pg.psqlFile(copy);
    }

    const newUser = (email) => pg.psql(`insert into auth.users (email) values ('${email}') returning id`);
    const planInList = (id) => pg.psql(`select plan from public.admin_users_page('', 100, 0) where id = '${id}'::uuid`);
    const planInDetail = (id) => pg.psql(`select public.admin_user_detail('${id}'::uuid) ->> 'plan'`);
    const resolved = (id) => pg.psql(`select tier from public.resolve_entitlement('${id}'::uuid)`);
    const assertEverywhere = (id, expected) => {
      assert.equal(resolved(id), expected);
      assert.equal(planInList(id), expected);
      assert.equal(planInDetail(id), expected);
    };

    const overlap = newUser("overlap@example.test");
    pg.psql(`insert into public.subscriptions (user_id, provider, status, tier, current_period_end, verified_at)
      values
      ('${overlap}', 'stripe', 'active', 'pro', now() + interval '2 days', now() - interval '2 days'),
      ('${overlap}', 'apple', 'trialing', 'plus', now() + interval '2 years', now())`);
    assertEverywhere(overlap, "pro");

    const statusUser = newUser("statuses@example.test");
    pg.psql(`insert into public.subscriptions (user_id, provider, status, tier, current_period_end, verified_at)
      values
      ('${statusUser}', 'stripe', 'expired', 'pro', now() + interval '1 year', now()),
      ('${statusUser}', 'apple', 'refunded', 'pro', now() + interval '1 year', now()),
      ('${statusUser}', 'stripe', 'active', 'plus', now() - interval '1 minute', now()),
      ('${statusUser}', 'apple', 'trialing', 'standard', now() + interval '1 day', now())`);
    assertEverywhere(statusUser, "standard");

    const admin = newUser("database-admin@example.test");
    pg.psql(`select public.set_account_role('database-admin@example.test', 'admin')`);
    assertEverywhere(admin, "admin");

    const seated = newUser("seated@example.test");
    const creator = newUser("creator@example.test");
    const application = pg.psql(`insert into public.organization_applications
      (applicant_user_id, organization_name, purpose, country, contact_email, applicant_role, status)
      values ('${creator}', 'Test Academy', 'Testing accurate access reporting.', 'Hong Kong', 'creator@example.test', 'Director', 'approved') returning id`);
    const organization = pg.psql(`insert into public.organizations
      (application_id, name, slug, join_code, status, created_by)
      values ('${application}', 'Test Academy', 'test-academy', 'abcdef123456', 'active', '${creator}') returning id`);
    const pool = pg.psql(`insert into public.organization_seat_pools
      (organization_id, provider, purchased_seats, status)
      values ('${organization}', 'manual', 10, 'active') returning id`);
    pg.psql(`insert into public.organization_seat_allocations
      (organization_id, seat_pool_id, user_id, status, allocated_by)
      values ('${organization}', '${pool}', '${seated}', 'active', '${creator}')`);
    assertEverywhere(seated, "free");
    assert.equal(pg.psql(`select organization_seat_count from public.admin_users_page('', 100, 0) where id = '${seated}'`), "1");
    assert.equal(pg.psql(`select jsonb_array_length(public.admin_user_detail('${seated}') -> 'organizationSeats')`), "1");

    pg.psql(`insert into public.progress_snapshots (user_id, store_key, payload, client_updated_at)
      values
      ('${seated}', 'ielts-prep-v1', '{"placement":{"band":6.5,"date":"2026-08-01"},"results":[{"testId":"r1"}],"mockReports":[{"id":"m1","marks":{"overall":7}}]}'::jsonb, '2026-08-03T10:00:00Z'),
      ('${seated}', 'bandup.drills.v1', '{"articles":{"correct":7,"total":8,"at":"2026-08-02"}}'::jsonb, '2026-08-04T11:00:00Z')`);
    const detail = JSON.parse(pg.psql(`select public.admin_user_detail('${seated}')`));
    assert.equal(detail.placement.band, 6.5);
    assert.equal(detail.results.length, 1);
    assert.equal(detail.mockReports.length, 1);
    assert.equal(detail.drillScores.articles.correct, 7);
    assert.match(detail.profileSyncedAt, /^2026-08-03T10:00:00/);
    assert.match(detail.drillsSyncedAt, /^2026-08-04T11:00:00/);
  } finally {
    teardown(pg);
  }
});

test("ADMIN_EMAILS is batch-applied to list and detail responses without per-user entitlement calls", () => {
  const helper = readFileSync(join(process.cwd(), "lib", "admin", "effective-access.ts"), "utf8");
  const listRoute = readFileSync(join(process.cwd(), "app", "api", "admin", "users", "route.ts"), "utf8");
  const detailRoute = readFileSync(join(process.cwd(), "app", "api", "admin", "users", "[id]", "route.ts"), "utf8");
  assert.match(helper, /new Set\(adminEmails\(\)\)/);
  assert.match(helper, /plan: "admin"/);
  assert.match(listRoute, /applyOwnerEffectiveAccess\(users\)/);
  assert.match(detailRoute, /applyOwnerEffectiveAccessToDetail\(user\)/);
  assert.doesNotMatch(helper, /resolveEntitlement|rpc</);

  const previous = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = " OWNER@example.test ";
  try {
    const rows = effectiveAccess.applyOwnerEffectiveAccess([
      { email: "owner@example.test", plan: "free", access_source: "default" },
      { email: "learner@example.test", plan: "plus", access_source: "stripe" },
    ]);
    assert.deepEqual(rows[0], { email: "owner@example.test", plan: "admin", access_source: "role" });
    assert.deepEqual(rows[1], { email: "learner@example.test", plan: "plus", access_source: "stripe" });
    assert.deepEqual(
      effectiveAccess.applyOwnerEffectiveAccessToDetail({
        email: "OWNER@example.test",
        plan: "standard",
        accessSource: "stripe",
      }),
      { email: "OWNER@example.test", plan: "admin", accessSource: "role" },
    );
  } finally {
    if (previous === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = previous;
  }
});

test("admin user APIs replace stale Supabase seat data with the active Cloudflare organisation authority", () => {
  const helper = readFileSync(join(process.cwd(), "lib", "cloudflare", "admin-organization-access.ts"), "utf8");
  const listRoute = readFileSync(join(process.cwd(), "app", "api", "admin", "users", "route.ts"), "utf8");
  const detailRoute = readFileSync(join(process.cwd(), "app", "api", "admin", "users", "[id]", "route.ts"), "utf8");

  assert.match(helper, /organization_seat_allocations allocation/);
  assert.match(helper, /pool\.status = 'active'/);
  assert.match(helper, /allocation\.status IN \('reserved', 'active'\)/);
  assert.match(listRoute, /organizationDataMode\(\) === "cloudflare"/);
  assert.match(listRoute, /organization_seat_count: seats\.get\(user\.id\)\?\.length \?\? 0/);
  assert.match(detailRoute, /cloudflareAdminOrganizationSeats\(\[user\.id\]\)/);
  assert.match(detailRoute, /organizationSeats/);
});

test("Cloudflare admin seat lookup returns only current allocations and uses a user-leading index", async () => {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(process.cwd(), "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(process.cwd(), "cloudflare", "migrations", file), "utf8"));
  }
  const owner = "50000000-0000-4000-8000-000000000001";
  const currentUser = "50000000-0000-4000-8000-000000000002";
  const expiredUser = "50000000-0000-4000-8000-000000000003";
  const created = "2026-08-01T00:00:00.000Z";
  for (const [id, email] of [[owner, "owner@example.test"], [currentUser, "current@example.test"], [expiredUser, "expired@example.test"]]) {
    database.prepare("INSERT INTO app_users (id,email,created_at,updated_at) VALUES (?,?,?,?)")
      .run(id, email, created, created);
  }
  const currentOrg = "11111111-1111-4111-8111-111111111111";
  const expiredOrg = "22222222-2222-4222-8222-222222222222";
  const applications = [
    ["40000000-0000-4000-8000-000000000001", "Current Academy"],
    ["40000000-0000-4000-8000-000000000002", "Expired Academy"],
  ];
  for (const [appId, name] of applications) {
    database.prepare("INSERT INTO organization_applications (id,applicant_user_id,organization_name,purpose,country,contact_email,applicant_role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(appId, owner, name, "Legacy purpose", "GB", "owner@example.test", "Owner", "approved", created, created);
  }
  for (const [id, name, appId] of [[currentOrg, "Current Academy", applications[0][0]], [expiredOrg, "Expired Academy", applications[1][0]]]) {
    database.prepare("INSERT INTO organizations (id,application_id,name,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, appId, name, "active", owner, created, created);
  }
  const currentPool = "30000000-0000-4000-8000-000000000001";
  const expiredPool = "30000000-0000-4000-8000-000000000002";
  database.prepare("INSERT INTO organization_seat_pools (id,organization_id,seat_count,starts_at,ends_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(currentPool, currentOrg, 10, created, "2099-01-01T00:00:00.000Z", "active", created, created);
  database.prepare("INSERT INTO organization_seat_pools (id,organization_id,seat_count,starts_at,ends_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(expiredPool, expiredOrg, 10, created, "2026-08-02T00:00:00.000Z", "expired", created, created);
  database.prepare("INSERT INTO organization_seat_allocations (id,organization_id,seat_pool_id,user_id,status,starts_at,allocated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("31000000-0000-4000-8000-000000000001", currentOrg, currentPool, currentUser, "reserved", created, owner, created, created);
  database.prepare("INSERT INTO organization_seat_allocations (id,organization_id,seat_pool_id,user_id,status,starts_at,allocated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("31000000-0000-4000-8000-000000000002", expiredOrg, expiredPool, expiredUser, "active", created, owner, created, created);

  const seats = await organizationAccess.cloudflareAdminOrganizationSeats(
    [currentUser, expiredUser],
    { db: runtimeD1(database), files: {} },
  );
  assert.equal(seats.get(currentUser).length, 1);
  assert.equal(seats.get(currentUser)[0].organizationName, "Current Academy");
  assert.equal(seats.get(expiredUser).length, 0);
  const plan = database.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM organization_seat_allocations
    WHERE user_id IN (?) AND status IN ('reserved','active')`).all(currentUser);
  assert.match(plan.map((row) => row.detail).join("\n"), /organization_seat_allocations_active_user_idx/);
});

test("admin progress uses the active snapshot authority and honours history tombstones", () => {
  const progress = userProgress.adminProgressFromSnapshots([
    {
      storeKey: "ielts-prep-v1",
      clientUpdatedAt: "2026-08-14T12:00:00.000Z",
      payload: {
        historyClearedAt: "2026-08-10T00:00:00.000Z",
        placement: { band: 7, date: "2026-08-13T00:00:00.000Z" },
        results: [
          { testId: "old", date: "2026-08-09T00:00:00.000Z" },
          { testId: "new", date: "2026-08-11T00:00:00.000Z" },
        ],
        mockReports: [
          { id: "old", completedAt: "2026-08-08T00:00:00.000Z" },
          { id: "new", completedAt: "2026-08-12T00:00:00.000Z" },
        ],
      },
    },
    {
      storeKey: "bandup.drills.v1",
      clientUpdatedAt: "2026-08-14T12:01:00.000Z",
      payload: { articles: { correct: 9, total: 10, at: "2026-08-14T12:01:00.000Z" } },
    },
  ], true);
  assert.equal(progress.progressAvailable, true);
  assert.deepEqual(progress.results.map((item) => item.testId), ["new"]);
  assert.deepEqual(progress.mockReports.map((item) => item.id), ["new"]);
  assert.equal(progress.placement.band, 7);
  assert.equal(progress.drillScores.articles.correct, 9);
  assert.equal(progress.profileSyncedAt, "2026-08-14T12:00:00.000Z");
  assert.equal(progress.drillsSyncedAt, "2026-08-14T12:01:00.000Z");

  assert.equal(userProgress.adminProgressFromSnapshots(null, false), null);
  assert.deepEqual(userProgress.adminProgressFromSnapshots(null, true), {
    placement: null,
    results: [],
    mockReports: [],
    drillScores: {},
    profileSyncedAt: null,
    drillsSyncedAt: null,
    progressAvailable: false,
  });
});

test("admin sitting links use immutable result identity instead of a mutable array index", () => {
  const first = { module: "reading", testId: "academic-100%", date: "2026-08-14T10:00:00.000Z", testTitle: "One", band: 7 };
  const second = { module: "writing", testId: "task-2", date: "2026-08-13T10:00:00.000Z", testTitle: "Two", band: 6.5 };
  const key = sittingKey.adminSittingKey(first);
  assert.deepEqual(sittingKey.findAdminSitting([second, first], key), first);
  assert.deepEqual(sittingKey.findAdminSitting([second, first], decodeURIComponent(key)), first);
  assert.equal(sittingKey.findAdminSitting([second], key), null);
  assert.equal(sittingKey.findAdminSitting([first], "not-json"), null);
});

test("the admin UI states effective access and synced-history boundaries honestly", () => {
  const list = readFileSync(join(process.cwd(), "app", "admin", "users", "page.tsx"), "utf8");
  const detail = readFileSync(join(process.cwd(), "app", "admin", "users", "[id]", "page.tsx"), "utf8");
  assert.match(list, /Effective access/);
  assert.match(list, /organisation seat/);
  assert.doesNotMatch(list, />Plan</);
  assert.match(detail, /Seats permit organisation membership; they do not change personal AI access/);
  assert.match(detail, /access-gate decisions, not completed AI responses/);
  assert.match(detail, /allowed · \{Number\(usage\.refused\)\} blocked before AI/);
  assert.match(detail, /Saved practice sittings in the synced database copy/);
  assert.match(detail, /Full mock sittings/);
  assert.match(detail, /Placement estimate/);
  assert.match(detail, /Drill progress/);
  assert.match(detail, /Older administrator totals may include automated diagnostic access checks/);
  assert.match(detail, /Synced \{new Intl\.DateTimeFormat\("en-GB"/);
  assert.match(detail, /sittings\/\$\{adminSittingKey\(result\)\}/);
  assert.doesNotMatch(detail, /sittings\/\$\{index\}/);

  const detailRoute = readFileSync(join(process.cwd(), "app", "api", "admin", "users", "[id]", "route.ts"), "utf8");
  assert.match(detailRoute, /getLearnerProgressSnapshots/);
  assert.match(detailRoute, /adminProgressFromSnapshots/);
  assert.match(detailRoute, /cloudflareDataMode\(\) === "cloudflare"/);
});
