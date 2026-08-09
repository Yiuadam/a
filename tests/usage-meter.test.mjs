/*
  Is the usage bar the meter, or a picture of one?

  The claim the app makes to a learner is specific: the number on the bar is
  the number being enforced. That claim cannot be checked by reading the code,
  because the two halves live in different places — `check_and_record_usage`
  decides, `usage_detail` reports, and nothing in TypeScript makes them agree.
  A stub that behaved the way they are supposed to behave would demonstrate
  only that the stub was written to match.

  So this provisions a throwaway Postgres, applies every migration exactly as a
  Supabase project would, and drives the real functions. What it proves:

    the bar counts what the gate counts — the same rows, the same window;
    the refusal lands exactly where the bar says it will, not one either side;
    a refused call does not inflate the bar, so being denied cannot cost you
      allowance you never spent;
    all five AI routes share one allowance, word lookup included;
    rows older than the window drop off, which is what "rolling" means;
    the owner's account has no cap and is still counted truthfully.

  ---------------------------------------------------------------------------
  When it cannot run

  It skips, loudly, and says why — the same shape tests/billing-migration.test.mjs
  uses. Only an assertion failure fails the test; a machine with no Postgres
  reports a skip. That is a real limitation and is stated rather than hidden:
  on such a machine this file proves nothing.
*/
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function findPostgresBin() {
  const base = "/usr/lib/postgresql";
  if (!existsSync(base)) return null;
  for (const version of readdirSync(base).filter((v) => /^\d+$/.test(v)).sort((a, b) => Number(b) - Number(a))) {
    const bin = join(base, version, "bin");
    if (existsSync(join(bin, "initdb")) && existsSync(join(bin, "psql"))) return bin;
  }
  return null;
}

const AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

function makeRunner(bin, dir) {
  return (command, args, options = {}) => {
    const file = join(bin, command);
    const base = { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], cwd: dir, ...options };
    return AS_ROOT
      ? execFileSync("runuser", ["-u", "postgres", "--", file, ...args], base)
      : execFileSync(file, args, base);
  };
}

const SUPABASE_STUB = `
create extension if not exists pgcrypto;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  created_at timestamptz not null default now()
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid;
$$;
grant usage on schema public, auth to anon, authenticated, service_role;
`;

function provision() {
  const bin = findPostgresBin();
  if (!bin) return { skip: "no PostgreSQL installation found under /usr/lib/postgresql" };
  if (AS_ROOT) {
    try {
      execFileSync("id", ["postgres"], { stdio: "ignore" });
    } catch {
      return { skip: "running as root with no `postgres` account to drop to" };
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "bandup-usage-pg-"));
  const data = join(dir, "data");
  const sock = join(dir, "sock");
  try {
    execFileSync("mkdir", ["-p", sock]);
    if (AS_ROOT) execFileSync("chown", ["-R", "postgres:postgres", dir]);
    const run = makeRunner(bin, dir);
    run("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
    run("pg_ctl", ["-D", data, "-o", `-p 5432 -k ${sock} -c listen_addresses='' -c fsync=off`, "-w", "-l", join(dir, "log"), "start"]);
    const psql = (sql) =>
      run("psql", ["-h", sock, "-p", "5432", "-U", "postgres", "-d", "postgres", "-tAq", "-v", "ON_ERROR_STOP=1", "-c", sql]).trim();
    const psqlFile = (file) =>
      run("psql", ["-h", sock, "-p", "5432", "-U", "postgres", "-d", "postgres", "-q", "-v", "ON_ERROR_STOP=1", "-f", file]);
    return { bin, dir, data, run, psql, psqlFile };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    return { skip: `could not start a cluster (${err instanceof Error ? err.message.split("\n")[0] : err})` };
  }
}

function teardown(pg) {
  try {
    pg.run("pg_ctl", ["-D", pg.data, "-m", "immediate", "-w", "stop"]);
  } catch {
    /* Already down. */
  }
  rmSync(pg.dir, { recursive: true, force: true });
}

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");
const WINDOW = 86400;

/*
  The app's own numbers, read out of lib/usage/limits.ts rather than repeated.
  A test with its own copy of the limits would keep passing after somebody
  changed the real ones.
*/
function appLimits() {
  const tiers = readFileSync(join(process.cwd(), "lib", "billing", "tiers.ts"), "utf8");
  const num = (tier) => {
    const at = tiers.indexOf(`  ${tier}: {`);
    const m = tiers.slice(at, at + 1200).match(/dailyAiCalls:\s*(null|\d+)/);
    return m ? (m[1] === "null" ? null : Number(m[1])) : null;
  };
  return { free: num("free"), pro: num("pro"), admin: num("admin"), anonymous: 0, ip: 60 };
}

const ROUTES = ["define", "generate", "grade/writing", "grade/speaking", "chat"];

test("the usage bar counts exactly what the gate enforces", async (t) => {
  const pg = provision();
  if (pg.skip) {
    t.diagnostic(`skipped: ${pg.skip}`);
    console.log(`  (skipped: ${pg.skip} — this file proves nothing on this machine)`);
    return;
  }

  try {
    const stubFile = join(pg.dir, "stub.sql");
    execFileSync("tee", [stubFile], { input: SUPABASE_STUB, stdio: ["pipe", "ignore", "ignore"] });
    if (AS_ROOT) execFileSync("chown", ["postgres:postgres", stubFile]);
    pg.psqlFile(stubFile);

    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
      const source = join(pg.dir, file);
      execFileSync("tee", [source], { input: readFileSync(join(MIGRATIONS, file)), stdio: ["pipe", "ignore", "ignore"] });
      if (AS_ROOT) execFileSync("chown", ["postgres:postgres", source]);
      pg.psqlFile(source);
    }

    const LIMITS = appLimits();
    assert.ok(Number.isInteger(LIMITS.free) && LIMITS.free > 0, "could not read the free allowance from tiers.ts");
    const limitsJson = JSON.stringify(LIMITS).replace(/'/g, "''");

    const user = pg.psql("insert into auth.users (email) values ('meter@example.test') returning id");
    assert.match(user, /^[0-9a-f-]{36}$/);

    /** One metered request, exactly as lib/usage/guard.ts makes it. */
    const call = (route) =>
      JSON.parse(
        pg.psql(
          `select to_jsonb(r) from public.check_and_record_usage(
             '${user}'::uuid, null, '${route}', ${WINDOW}, '${limitsJson}'::jsonb) r`,
        ),
      );

    /** What the bar is drawn from, exactly as /api/account/status reads it. */
    const bar = () => JSON.parse(pg.psql(`select public.usage_detail('${user}'::uuid, ${WINDOW})`));

    // ---- 1. An empty bar, before anything ---------------------------------
    assert.deepEqual(bar(), { used: 0, oldest_at: null, by_route: {} }, "a new account starts at zero");

    // ---- 2. Every route counts, word lookup included ----------------------
    for (const route of ROUTES) {
      const decision = call(route);
      assert.equal(decision.allowed, true, `${route} should be allowed at the start`);
    }
    const afterFive = bar();
    assert.equal(afterFive.used, ROUTES.length, "all five routes land on one allowance");
    for (const route of ROUTES) {
      assert.equal(afterFive.by_route[route], 1, `${route} is missing from the breakdown`);
    }
    /* Two more lookups, to show define is counted per call and not per kind. */
    call("define");
    call("define");
    assert.equal(bar().by_route["define"], 3, "each word lookup counts");
    assert.equal(bar().used, ROUTES.length + 2);

    // ---- 3. The gate and the bar agree about the number ------------------
    let last = null;
    for (let i = bar().used; i < LIMITS.free; i += 1) last = call("define");
    assert.equal(last.allowed, true, "the last call inside the allowance must be allowed");
    assert.equal(bar().used, LIMITS.free, "the bar reads full exactly at the allowance");

    // ---- 4. The refusal lands where the bar said it would ----------------
    const refused = call("define");
    assert.equal(refused.allowed, false, "the call past the allowance must be refused");
    assert.equal(refused.reason, "quota_exceeded", `refused for the wrong reason: ${refused.reason}`);

    // ---- 5. A refusal does not cost allowance ---------------------------
    assert.equal(
      bar().used,
      LIMITS.free,
      "a denied call must not inflate the bar — being refused cannot spend what you never used",
    );
    const denied = Number(
      pg.psql(`select count(*) from public.usage_events where user_id = '${user}'::uuid and outcome <> 'admitted'`),
    );
    assert.ok(denied >= 1, "the refusal should still be recorded, just not counted");

    // ---- 6. The window rolls ---------------------------------------------
    pg.psql(
      `update public.usage_events set created_at = now() - interval '25 hours'
         where user_id = '${user}'::uuid and outcome = 'admitted'`,
    );
    assert.equal(bar().used, 0, "rows older than the window drop off the bar");
    const afterRollover = call("define");
    assert.equal(afterRollover.allowed, true, "and the gate lets you back in once they have");

    // ---- 7. The owner has no cap, and is still counted -------------------
    const owner = pg.psql("insert into auth.users (email) values ('owner@example.test') returning id");
    pg.psql(`select public.set_account_role('owner@example.test', 'admin')`);
    const ownerCall = (route) =>
      JSON.parse(
        pg.psql(
          `select to_jsonb(r) from public.check_and_record_usage(
             '${owner}'::uuid, null, '${route}', ${WINDOW}, '${limitsJson}'::jsonb) r`,
        ),
      );
    for (let i = 0; i < LIMITS.free + 5; i += 1) {
      const d = ownerCall("chat");
      assert.equal(d.allowed, true, `the owner was refused at call ${i + 1}`);
    }
    const ownerBar = JSON.parse(pg.psql(`select public.usage_detail('${owner}'::uuid, ${WINDOW})`));
    assert.equal(ownerBar.used, LIMITS.free + 5, "an uncapped account is still counted honestly");

    console.log(
      `  proved against Postgres: ${LIMITS.free} free calls, refusal at ${LIMITS.free + 1}, ` +
        `${ROUTES.length} routes on one allowance, denials excluded, window rolls.`,
    );
  } finally {
    teardown(pg);
  }
});
