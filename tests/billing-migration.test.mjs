/*
  The idempotency guarantee, run against a real Postgres.

  tests/billing-webhook.test.mjs covers the half of the webhook that is
  JavaScript. The half that actually holds the line is SQL — the claim on
  `provider_events`, the refusal of an out-of-order redelivery, and the fact
  that both live in the same transaction as the write. None of that can be
  demonstrated by reading it, and a stub that behaves the way the SQL is
  supposed to behave demonstrates only that the stub was written to match.

  So this provisions a throwaway cluster, applies the migrations exactly as a
  Supabase project would, and drives
  `apply_provider_subscription_event` through the sequences that go wrong in
  production: the same delivery twice, an old event arriving after a newer one,
  a cancellation followed by a redelivered renewal.

  ---------------------------------------------------------------------------
  When it cannot run

  It skips, loudly, and says why — the same shape tests/no-secret-leak.test.mjs
  uses when there is no build output to read. Only an assertion failure fails
  the test; a machine with no Postgres, or one where the cluster will not
  start, reports a skip rather than a red build. That is a real limitation and
  is stated rather than hidden: on such a machine this file proves nothing.
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

/*
  A Supabase-shaped stub. The migrations reference `auth.users`, `auth.uid()`
  and the three Supabase roles, and none of those exist in a bare cluster —
  so the parts of the schema this test does not own are faked just far enough
  for the parts it does own to be real.
*/

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

  const dir = mkdtempSync(join(tmpdir(), "bandup-billing-pg-"));
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

test("the webhook's idempotency holds in the database that enforces it", async (t) => {
  const pg = provision();
  if (pg.skip) {
    t.diagnostic(`skipped: ${pg.skip}`);
    console.log(`  (skipped: ${pg.skip} — this file proves nothing on this machine)`);
    return;
  }

  try {
    // The stub, then every migration in filename order, exactly as a project
    // applies them. 0005's storage steps are guarded and report notices here.
    const stubFile = join(pg.dir, "stub.sql");
    execFileSync("tee", [stubFile], { input: SUPABASE_STUB, stdio: ["pipe", "ignore", "ignore"] });
    if (AS_ROOT) execFileSync("chown", ["postgres:postgres", stubFile]);
    pg.psqlFile(stubFile);

    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
      const source = join(pg.dir, file);
      execFileSync("tee", [source], {
        input: readFileSync(join(MIGRATIONS, file)),
        stdio: ["pipe", "ignore", "ignore"],
      });
      if (AS_ROOT) execFileSync("chown", ["postgres:postgres", source]);
      pg.psqlFile(source);
    }

    const user = pg.psql("insert into auth.users (email) values ('learner@example.test') returning id");
    assert.match(user, /^[0-9a-f-]{36}$/);

    const apply = (args) =>
      pg.psql(`select public.apply_provider_subscription_event(${args})`);

    const q = (v) => (v === null ? "null" : `'${String(v).replace(/'/g, "''")}'`);
    const call = ({
      id,
      at,
      userId = null,
      status,
      tier = "pro",
      sub = "sub_1",
      cus = "cus_1",
      end = null,
      cancel = false,
    }) =>
      apply(
        [
          `'stripe'`,
          q(id),
          `${q(at)}::timestamptz`,
          `'{"id":${JSON.stringify(id)}}'::jsonb`,
          userId === null ? "null" : `${q(userId)}::uuid`,
          q(status),
          q(tier),
          q(cus),
          q(sub),
          `'price_month'`,
          end === null ? "null" : `${q(end)}::timestamptz`,
          cancel ? "true" : "false",
        ].join(","),
      );

    /* ------------------------------------------------------------------ */

    /*
      Day offsets rather than calendar dates. This narrative used to run on
      fixed 2026 timestamps, and the one assertion below that checks the
      subscription is still current — not merely that it was recorded —
      compares against Postgres's real `now()`. A calendar date is only ever
      in the right place relative to "now" on the days its author was
      thinking of; every day after that the whole premise (the period has
      not ended yet) quietly becomes false, and the assertion fails with no
      code change at all. Anchoring day 0 five days before the moment the
      test actually runs keeps that premise true no matter when it runs,
      the same reason the admin-tier-counts test below already writes
      `now() + interval` instead of a date.
    */
    const DAY_MS = 24 * 60 * 60 * 1000;
    const day0 = Date.now() - 5 * DAY_MS;
    const day = (n, extraMs = 0) => new Date(day0 + n * DAY_MS + extraMs).toISOString();

    await t.test("the first delivery applies, and a redelivery does not", () => {
      assert.equal(
        call({ id: "evt_1", at: day(0), userId: user, status: "active", end: day(31) }),
        "applied",
      );
      // The redelivery Stripe makes when it did not see a 200 quickly enough,
      // here carrying a payload that would revoke the subscription if it were
      // processed a second time.
      assert.equal(
        call({ id: "evt_1", at: day(0), userId: user, status: "canceled", end: null }),
        "duplicate",
      );
      assert.equal(pg.psql("select count(*) from public.subscriptions"), "1");
      assert.equal(pg.psql("select status from public.subscriptions"), "active");
      assert.equal(pg.psql(`select tier from public.resolve_entitlement('${user}')`), "pro");
    });

    await t.test("a renewal with no metadata still finds the account", () => {
      assert.equal(
        call({ id: "evt_2", at: day(31, 1000), status: "active", end: day(61) }),
        "applied",
      );
      assert.equal(pg.psql("select count(*) from public.subscriptions"), "1");
    });

    await t.test("a cancellation drops the entitlement", () => {
      assert.equal(
        call({ id: "evt_3", at: day(40), userId: user, status: "canceled", end: day(61), cancel: true }),
        "applied",
      );
      assert.equal(pg.psql(`select tier from public.resolve_entitlement('${user}')`), "free");
    });

    await t.test("an older event delivered late cannot resurrect a cancellation", () => {
      // The bug idempotency alone does not prevent: every event is distinct, so
      // every event is applied, and the last one to *arrive* wins.
      assert.equal(
        call({ id: "evt_4", at: day(14), userId: user, status: "active", end: day(61) }),
        "stale",
      );
      assert.equal(pg.psql(`select tier from public.resolve_entitlement('${user}')`), "free");
      // Recorded all the same, so it is never reconsidered.
      assert.equal(pg.psql("select count(*) from public.provider_events where event_id = 'evt_4'"), "1");
    });

    await t.test("a renewal finds the account through the customer alone", () => {
      // No metadata and a subscription id this database has not seen, but a
      // customer it has: the second of the three ways an event is placed.
      assert.equal(
        call({ id: "evt_5", at: day(51), status: "active", sub: "sub_2", end: day(92) }),
        "applied",
      );
      assert.equal(pg.psql("select count(*) from public.subscriptions"), "2");
    });

    await t.test("an event for a subscription and customer nobody here has seen writes nothing", () => {
      assert.equal(
        call({
          id: "evt_6",
          at: day(50),
          status: "active",
          sub: "sub_unknown",
          cus: "cus_unknown",
        }),
        "unknown_user",
      );
      // Not even a claim: a redelivery after the account has been linked by
      // some other event must still be free to apply.
      assert.equal(pg.psql("select count(*) from public.provider_events where event_id = 'evt_6'"), "0");
    });

    await t.test("a signed-in learner cannot call any of it", () => {
      // The whole of ACCOUNTS.md threat 3, asked of the database directly —
      // which is what a stolen token pointed at PostgREST would do.
      const denied = pg.psql(`
        do $p$
        declare u uuid; begin
          select id into u from auth.users limit 1;
          perform set_config('request.jwt.claims', json_build_object('sub', u, 'role','authenticated')::text, true);
          set local role authenticated;
          begin
            perform public.apply_provider_subscription_event(
              'stripe','evt_hack', now(), '{}'::jsonb, u, 'active','pro','c','s',null,null,false);
            raise exception 'a signed-in user granted themselves a subscription';
          exception when insufficient_privilege then null;
          end;
          begin
            insert into public.subscriptions (user_id, provider, status, tier) values (u,'stripe','active','pro');
            raise exception 'a signed-in user inserted their own subscription';
          exception when insufficient_privilege then null;
          end;
        end $p$;
        select 'denied'`);
      assert.equal(denied, "denied");
    });

    await t.test("admin tier counts use one current effective tier per account", () => {
      const baseline = JSON.parse(
        pg.psql("select coalesce(jsonb_object_agg(tier, count), '{}'::jsonb) from public.admin_tier_counts()"),
      );
      const overlap = pg.psql("insert into auth.users (email) values ('overlap@example.test') returning id");
      const expired = pg.psql("insert into auth.users (email) values ('expired@example.test') returning id");
      const refunded = pg.psql("insert into auth.users (email) values ('refunded@example.test') returning id");
      const envAdmin = pg.psql("insert into auth.users (email) values ('env-admin@example.test') returning id");

      pg.psql(`
        insert into public.subscriptions
          (user_id, provider, status, tier, external_subscription_id, current_period_end)
        values
          ('${overlap}', 'stripe', 'active', 'standard', 'sub_overlap_standard', now() + interval '30 days'),
          ('${overlap}', 'apple', 'active', 'pro', 'sub_overlap_pro', now() + interval '10 days'),
          ('${expired}', 'stripe', 'active', 'pro', 'sub_expired', now() - interval '1 day'),
          ('${refunded}', 'stripe', 'refunded', 'pro', 'sub_refunded', now() + interval '30 days')
      `);

      const counted = JSON.parse(
        pg.psql(`select coalesce(jsonb_object_agg(tier, count), '{}'::jsonb)
                   from public.admin_tier_counts('${envAdmin}')`),
      );
      const value = (record, tier) => Number(record[tier] ?? 0);
      assert.equal(value(counted, "pro"), value(baseline, "pro") + 1,
        "overlapping Standard and Pro rows must count one effective Pro account");
      assert.equal(value(counted, "standard"), value(baseline, "standard"),
        "the weaker overlapping row must not be counted separately");
      assert.equal(value(counted, "free"), value(baseline, "free") + 2,
        "expired and refunded rows must resolve to free");
      assert.equal(value(counted, "admin"), value(baseline, "admin") + 1,
        "the verified ADMIN_EMAILS actor is counted as admin even without a stored role");
    });

    await t.test("admin usage breakdown names pre-provider decisions without identities", () => {
      pg.psql(`
        insert into public.usage_events (user_id, route, outcome) values
          ('${user}', 'chat', 'admitted'),
          ('${user}', 'chat', 'denied_quota'),
          ('${user}', 'chat', 'denied_rate'),
          (null, 'define', 'denied_quota')
      `);
      assert.equal(
        pg.psql(`select count from public.admin_usage_breakdown(30)
                  where route = 'chat' and decision = 'allowed' and caller = 'signed_in'`),
        "1",
      );
      assert.equal(
        pg.psql(`select count from public.admin_usage_breakdown(30)
                  where route = 'chat' and decision = 'blocked_quota' and caller = 'signed_in'`),
        "1",
      );
      assert.equal(
        pg.psql(`select count from public.admin_usage_breakdown(30)
                  where route = 'chat' and decision = 'blocked_rate' and caller = 'signed_in'`),
        "1",
      );
      assert.equal(
        pg.psql(`select count from public.admin_usage_breakdown(30)
                  where route = 'define' and decision = 'blocked_quota' and caller = 'anonymous'`),
        "1",
      );
      assert.equal(
        pg.psql(`select coalesce(sum(count), 0) from public.admin_usage_breakdown(30, '${user}')
                  where caller = 'signed_in'`),
        "0",
        "the verified owner must not inflate learner-demand breakdowns",
      );
      assert.equal(
        pg.psql(`select coalesce(sum(admitted + denied), 0)
                   from public.admin_usage_daily(30, '${user}')`),
        "1",
        "the daily learner chart keeps anonymous demand while excluding owner diagnostics",
      );
    });
  } finally {
    teardown(pg);
  }
});
