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
    each route has its own allowance, so running out of one leaves the others
      untouched — which is the whole reason the caps were split up, and the
      thing a shared pool could not do;
    the daily ceiling stops a month being spent in an afternoon, and reports
      itself as a different refusal from running out for the month;
    rows older than the window drop off, which is what "rolling" means;
    a tier with no AI is refused before it can spend anything, and so is a tier
      name this build has never heard of — the one path that costs real money
      must not be the one that is easiest to reach by accident;
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
import { register } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SUPABASE_STUB } from "./supabase-stub.mjs";

register("./alias-resolve.mjs", import.meta.url);

/*
  The app's own numbers, imported rather than repeated. A test carrying its own
  copy of the limits would keep passing after somebody changed the real ones,
  which is the failure this file exists to rule out.
*/
const limitsModule = await import(
  pathToFileURL(join(process.cwd(), "lib", "usage", "limits.ts")).href
);
const tiersModule = await import(
  pathToFileURL(join(process.cwd(), "lib", "billing", "tiers.ts")).href
);
const LIMITS = limitsModule.limitsForDatabase();
const { monthlyCap, weeklyCap } = tiersModule;

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

    const limitsJson = JSON.stringify(LIMITS).replace(/'/g, "''");
    const MONTH = LIMITS.month_seconds;

    const newUser = (email) => {
      const id = pg.psql(`insert into auth.users (email) values ('${email}') returning id`);
      assert.match(id, /^[0-9a-f-]{36}$/);
      return id;
    };

    /** One metered request, exactly as lib/usage/guard.ts makes it. */
    const callFor = (id) => (route) =>
      JSON.parse(
        pg.psql(
          `select to_jsonb(r) from public.check_and_record_usage(
             '${id}'::uuid, null, '${route}', ${WINDOW}, '${limitsJson}'::jsonb) r`,
        ),
      );

    /** What the bars are drawn from, exactly as /api/account/status reads it. */
    const barFor = (id) => JSON.parse(pg.psql(`select public.usage_detail('${id}'::uuid, ${MONTH})`));

    /*
      Ages this account's admitted rows out of the 24-hour window while leaving
      them inside the 30-day one. That is the only way to spend a whole month's
      allowance in a test: the daily ceiling exists precisely to stop it
      happening in one sitting.
    */
    const nextDay = (id) =>
      pg.psql(
        `update public.usage_events set created_at = created_at - interval '25 hours'
           where user_id = '${id}'::uuid and outcome = 'admitted'`,
      );

    // ---- A tier with no AI is refused before it can spend anything -------
    const freeUser = newUser("free@example.test");
    const freeCall = callFor(freeUser);
    for (const route of ROUTES) {
      const decision = freeCall(route);
      assert.equal(decision.allowed, false, `a free account was allowed ${route}`);
      assert.equal(decision.reason, "quota_exceeded", `${route} refused for the wrong reason`);
    }
    assert.equal(barFor(freeUser).used, 0, "a refused free account must not have spent anything");

    // ---- A Plus subscriber ------------------------------------------------
    const user = newUser("plus@example.test");
    pg.psql(
      `insert into public.subscriptions (user_id, provider, status, tier, current_period_end)
         values ('${user}'::uuid, 'stripe', 'active', 'plus', now() + interval '30 days')`,
    );
    const entitlement = pg.psql(`select tier from public.resolve_entitlement('${user}'::uuid)`);
    assert.equal(entitlement, "plus", "the subscription row did not resolve to the plus tier");

    const call = callFor(user);
    const bar = () => barFor(user);

    // ---- 1. An empty bar, before anything ---------------------------------
    assert.deepEqual(bar(), { used: 0, oldest_at: null, by_route: {} }, "a new account starts at zero");

    // ---- 2. Every route counts, separately --------------------------------
    for (const route of ROUTES) {
      assert.equal(call(route).allowed, true, `${route} should be allowed at the start`);
    }
    const afterFive = bar();
    assert.equal(afterFive.used, ROUTES.length);
    for (const route of ROUTES) {
      assert.equal(afterFive.by_route[route], 1, `${route} is missing from the breakdown`);
    }

    // ---- 3. The daily ceiling stops a month being spent in an afternoon ----
    const WEEK = weeklyCap("plus", "grade/writing");
    const MONTHLY = monthlyCap("plus", "grade/writing");
    assert.ok(WEEK > 0 && MONTHLY > WEEK, "this test needs a daily ceiling below the monthly cap");

    for (let i = bar().by_route["grade/writing"] ?? 0; i < WEEK; i += 1) {
      assert.equal(call("grade/writing").allowed, true, `refused inside the daily ceiling at ${i}`);
    }
    const dayFull = call("grade/writing");
    assert.equal(dayFull.allowed, false, "the call past the daily ceiling must be refused");
    assert.equal(
      dayFull.reason,
      "rate_limited",
      "running out for the day is not the same as running out for the month, and must not say so",
    );

    // ---- 4. Another route is untouched by it ------------------------------
    assert.equal(
      call("define").allowed,
      true,
      "one allowance running out must not touch another — this is why the caps were split up",
    );

    // ---- 5. Spend the month, a day at a time ------------------------------
    while ((bar().by_route["grade/writing"] ?? 0) < MONTHLY) {
      nextDay(user);
      const before = bar().by_route["grade/writing"] ?? 0;
      for (let i = 0; i < Math.min(WEEK, MONTHLY - before); i += 1) {
        assert.equal(
          call("grade/writing").allowed,
          true,
          `refused inside the monthly allowance at ${before + i}`,
        );
      }
    }
    assert.equal(
      bar().by_route["grade/writing"],
      MONTHLY,
      "the bar reads full exactly at the monthly allowance",
    );

    // ---- 6. The refusal lands where the bar said it would -----------------
    const refused = call("grade/writing");
    assert.equal(refused.allowed, false, "the call past the allowance must be refused");
    assert.equal(refused.reason, "quota_exceeded", `refused for the wrong reason: ${refused.reason}`);

    // ---- 7. A refusal does not cost allowance -----------------------------
    assert.equal(
      bar().by_route["grade/writing"],
      MONTHLY,
      "a denied call must not inflate the bar — being refused cannot spend what you never used",
    );
    const denied = Number(
      pg.psql(`select count(*) from public.usage_events where user_id = '${user}'::uuid and outcome <> 'admitted'`),
    );
    assert.ok(denied >= 2, "both refusals should still be recorded, just not counted");

    // ---- 8. The window rolls ----------------------------------------------
    pg.psql(
      `update public.usage_events set created_at = now() - interval '31 days'
         where user_id = '${user}'::uuid and outcome = 'admitted'`,
    );
    assert.equal(bar().used, 0, "rows older than the window drop off the bar");
    assert.equal(call("grade/writing").allowed, true, "and the gate lets you back in once they have");

    // ---- 9. A tier this build has never heard of is refused ---------------
    const stranger = newUser("stranger@example.test");
    pg.psql(
      `insert into public.subscriptions (user_id, provider, status, tier, current_period_end)
         values ('${stranger}'::uuid, 'stripe', 'active', 'plus', now() + interval '30 days')`,
    );
    /*
      A tier written by a newer deploy than the one running. The CHECK
      constraint is widened here rather than dropped, so this stands in for the
      shape of the problem: a tier name the payload carries no allowances for.
      Read as unlimited it would be the cheapest way to a free API; it must read
      as zero.
    */
    pg.psql(`alter table public.subscriptions drop constraint subscriptions_tier_check`);
    pg.psql(`update public.subscriptions set tier = 'platinum' where user_id = '${stranger}'::uuid`);
    const strange = callFor(stranger)("chat");
    assert.equal(strange.allowed, false, "an unrecognised tier was given an uncapped API");
    assert.equal(strange.reason, "quota_exceeded");
    assert.equal(barFor(stranger).used, 0);

    // ---- 10. The owner has no cap, and is still counted -------------------
    const owner = newUser("owner@example.test");
    pg.psql(`select public.set_account_role('owner@example.test', 'admin')`);
    const ownerCall = callFor(owner);
    const beyond = MONTHLY + 5;
    for (let i = 0; i < beyond; i += 1) {
      assert.equal(ownerCall("chat").allowed, true, `the owner was refused at call ${i + 1}`);
    }
    assert.equal(barFor(owner).used, beyond, "an uncapped account is still counted honestly");

    console.log(
      `  proved against Postgres: plus gets ${WEEK} essays a day and ${MONTHLY} a month, ` +
        `refusal at ${MONTHLY + 1}, free gets none, other routes unaffected, ` +
        `denials excluded, both windows roll.`,
    );
  } finally {
    teardown(pg);
  }
});
