/*
  The tier rename, run against a real Postgres.

  0032_tracking_and_ai_tiers.sql is not "no rows to worry about" the way its
  old header claimed — production holds three subscriptions rows still named
  'pro' (two free trials, one paid yearly), and this migration's whole safety
  argument is that the rename happens before the tightened CHECK is added.
  That argument is only proven by watching Postgres apply it to real rows:
  seed three accounts on the three retired tier names exactly as 0012 defined
  them, apply every migration up to 0032, then apply 0032 itself and watch
  the CHECK, the DEFAULT and resolve_entitlement all agree with the new
  names — the same reason tests/billing-migration.test.mjs runs
  apply_provider_subscription_event against a real cluster rather than a
  stub written to match the code under test.

  ---------------------------------------------------------------------------
  When it cannot run

  It skips, loudly, and says why — the same shape tests/billing-migration.
  test.mjs and tests/no-secret-leak.test.mjs use. Only an assertion failure
  fails the test; a machine with no Postgres, or one where the cluster will
  not start, reports a skip rather than a red build. That is a real
  limitation and is stated rather than hidden: on such a machine this file
  proves nothing.
*/
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUPABASE_STUB } from "./supabase-stub.mjs";

/** The newest Postgres in the usual Debian/Ubuntu location. */
function findPostgresBin() {
  const base = "/usr/lib/postgresql";
  if (!existsSync(base)) return null;
  const versions = readdirSync(base)
    .filter((v) => /^\d+$/.test(v))
    .sort((a, b) => Number(b) - Number(a));
  for (const version of versions) {
    const bin = join(base, version, "bin");
    if (existsSync(join(bin, "initdb")) && existsSync(join(bin, "psql"))) return bin;
  }
  return null;
}

/*
  `initdb` refuses to run as root, which is the common case inside a container.
  Where there is a `postgres` account, the commands are run as it; where there
  is not, and we are root, there is nothing to do but skip.
*/
const AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

function makeRunner(bin, dir) {
  return (command, args, options = {}) => {
    const file = join(bin, command);
    if (AS_ROOT) {
      return execFileSync("runuser", ["-u", "postgres", "--", file, ...args], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        cwd: dir,
        ...options,
      });
    }
    return execFileSync(file, args, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: dir,
      ...options,
    });
  };
}

/** Brings a cluster up, or returns the reason it could not. */
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

  const dir = mkdtempSync(join(tmpdir(), "bandup-tier-rename-pg-"));
  const data = join(dir, "data");
  const sock = join(dir, "sock");

  try {
    execFileSync("mkdir", ["-p", sock]);
    if (AS_ROOT) execFileSync("chown", ["-R", "postgres:postgres", dir]);

    const run = makeRunner(bin, dir);
    run("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
    run("pg_ctl", [
      "-D",
      data,
      "-o",
      `-p 5432 -k ${sock} -c listen_addresses='' -c fsync=off`,
      "-w",
      "-l",
      join(dir, "log"),
      "start",
    ]);

    const psql = (sql) =>
      run("psql", ["-h", sock, "-p", "5432", "-U", "postgres", "-d", "postgres", "-tAq", "-v", "ON_ERROR_STOP=1", "-c", sql]).trim();

    const psqlFile = (file) =>
      run("psql", ["-h", sock, "-p", "5432", "-U", "postgres", "-d", "postgres", "-q", "-v", "ON_ERROR_STOP=1", "-f", file]);

    return { bin, dir, data, sock, run, psql, psqlFile };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    return { skip: `could not start a cluster (${err instanceof Error ? err.message.split("\n")[0] : err})` };
  }
}

function teardown(pg) {
  try {
    pg.run("pg_ctl", ["-D", pg.data, "-m", "immediate", "-w", "stop"]);
  } catch {
    // Already down, or never came up. Either way the directory goes next.
  }
  rmSync(pg.dir, { recursive: true, force: true });
}

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");
const MIGRATION_0032 = "0032_tracking_and_ai_tiers.sql";

/** Copies a migration into the cluster's own directory and applies it. */
function applyMigration(pg, name) {
  const source = join(pg.dir, name);
  execFileSync("tee", [source], {
    input: readFileSync(join(MIGRATIONS, name)),
    stdio: ["pipe", "ignore", "ignore"],
  });
  if (AS_ROOT) execFileSync("chown", ["postgres:postgres", source]);
  pg.psqlFile(source);
}

test("0032 renames the three live 'pro'-family rows instead of finding none", async (t) => {
  const pg = provision();
  if (pg.skip) {
    t.diagnostic(`skipped: ${pg.skip}`);
    console.log(`  (skipped: ${pg.skip} — this file proves nothing on this machine)`);
    return;
  }

  try {
    // The stub, then every migration up to and including 0031 — the schema
    // exactly as it stands the instant before 0032 is applied.
    const stubFile = join(pg.dir, "stub.sql");
    execFileSync("tee", [stubFile], { input: SUPABASE_STUB, stdio: ["pipe", "ignore", "ignore"] });
    if (AS_ROOT) execFileSync("chown", ["postgres:postgres", stubFile]);
    pg.psqlFile(stubFile);

    const allMigrations = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    assert.ok(allMigrations.includes(MIGRATION_0032), "0032 must exist to be tested");
    const upToAndIncluding0031 = allMigrations.filter((f) => f !== MIGRATION_0032);

    for (const file of upToAndIncluding0031) applyMigration(pg, file);

    // ------------------------------------------------------------ seed --
    // Three accounts, one on each retired tier, exactly as 0012 named them:
    // 'standard', 'plus' and 'pro' — 'pro' playing the part of both a real
    // Stripe subscriber and (implicitly, since the migration cannot tell
    // the two apart by row shape) a free-trial grant, since both are the
    // same tier name on this table.
    const standardUser = pg.psql("insert into auth.users (email) values ('standard@example.test') returning id");
    const plusUser = pg.psql("insert into auth.users (email) values ('plus@example.test') returning id");
    const proUser = pg.psql("insert into auth.users (email) values ('pro@example.test') returning id");
    assert.match(standardUser, /^[0-9a-f-]{36}$/);
    assert.match(plusUser, /^[0-9a-f-]{36}$/);
    assert.match(proUser, /^[0-9a-f-]{36}$/);

    pg.psql(`
      insert into public.subscriptions
        (user_id, provider, status, tier, external_subscription_id, current_period_end)
      values
        ('${standardUser}', 'stripe', 'active', 'standard', 'sub_standard', now() + interval '30 days'),
        ('${plusUser}', 'stripe', 'active', 'plus', 'sub_plus', now() + interval '30 days'),
        ('${proUser}', 'stripe', 'active', 'pro', 'sub_pro', now() + interval '30 days')
    `);

    await t.test("pre-0032: the three rows still carry the retired names", () => {
      assert.equal(pg.psql(`select tier from public.subscriptions where user_id = '${standardUser}'`), "standard");
      assert.equal(pg.psql(`select tier from public.subscriptions where user_id = '${plusUser}'`), "plus");
      assert.equal(pg.psql(`select tier from public.subscriptions where user_id = '${proUser}'`), "pro");
    });

    // ------------------------------------------------------------ apply --
    applyMigration(pg, MIGRATION_0032);

    await t.test("post-0032: standard -> tracking, plus -> ai, pro -> ai", () => {
      assert.equal(pg.psql(`select tier from public.subscriptions where user_id = '${standardUser}'`), "tracking");
      assert.equal(pg.psql(`select tier from public.subscriptions where user_id = '${plusUser}'`), "ai");
      assert.equal(pg.psql(`select tier from public.subscriptions where user_id = '${proUser}'`), "ai");
    });

    await t.test("post-0032: 'pro' is no longer an insertable tier", () => {
      const checked = pg.psql(`
        do $p$
        begin
          begin
            insert into public.subscriptions (user_id, provider, status, tier)
              values ('${proUser}', 'stripe', 'active', 'pro');
            raise exception 'a row with tier ''pro'' was inserted after 0032';
          exception when check_violation then null;
          end;
        end $p$;
        select 'checked'`);
      assert.equal(checked, "checked");
    });

    await t.test("post-0032: a row that omits tier defaults to 'free', not 'pro'", () => {
      const insertedId = pg.psql(`
        insert into public.subscriptions (user_id, provider, status)
          values ('${standardUser}', 'stripe', 'active')
          returning id`);
      assert.equal(pg.psql(`select tier from public.subscriptions where id = '${insertedId}'`), "free");
    });

    await t.test("post-0032: resolve_entitlement reports the ex-'pro' account as 'ai'", () => {
      assert.equal(pg.psql(`select tier from public.resolve_entitlement('${proUser}')`), "ai");
    });

    await t.test("0032 is idempotent: applying it a second time changes nothing further", () => {
      applyMigration(pg, MIGRATION_0032);
      // By subscription id, not user: the default-tier subtest above gave
      // standardUser a second row, and this is about the seeded ones.
      const seeded = (externalId) =>
        pg.psql(`select tier from public.subscriptions where external_subscription_id = '${externalId}'`);
      assert.equal(seeded("sub_standard"), "tracking");
      assert.equal(seeded("sub_plus"), "ai");
      assert.equal(seeded("sub_pro"), "ai");
      assert.equal(pg.psql(`select tier from public.subscriptions where user_id = '${plusUser}'`), "ai");
      assert.equal(pg.psql(`select tier from public.subscriptions where user_id = '${proUser}'`), "ai");
      assert.equal(
        pg.psql("select count(*) from public.subscriptions"),
        "4",
        "re-running the migration must not touch row count",
      );
    });
  } finally {
    teardown(pg);
  }
});
