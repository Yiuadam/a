/*
  startNativePasswordRegistration's INSERT into app_password_credentials once
  named five `?` placeholders and passed `.bind()` six values -- a doubled-up
  `at` left over from an edit. Real D1 rejects a bound statement whose
  argument count does not match its placeholder count with "D1_ERROR: Wrong
  number of parameter bindings for SQL query". That insert shares a batch with
  the app_users insert, so the rejection rolled the whole batch back; the
  catch block below then re-read app_users for the address, found nothing,
  and returned false. Every native email/password sign-up in production
  answered false (a 503), and nobody ever received a confirmation email.

  No existing test caught it, because every fake handed to `bindings.db`
  elsewhere in this suite accepts whatever `.bind(...)` is given without
  checking it against the statement -- JavaScript does not mind a function
  call with the wrong number of arguments, so neither did those fakes. This
  file replays the real migrations into node:sqlite's DatabaseSync instead:
  real SQLite does check a bound statement's argument count, the same way D1
  does (see the first test below), so a mismatch here fails a test the same
  way it failed in production.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const ROOT = process.cwd();
const load = (...parts) => import(pathToFileURL(join(ROOT, ...parts)).href);

const nativeEmail = await load("lib", "auth", "native-email.ts");
const { startNativePasswordRegistration } = nativeEmail;

/*
  Same shape as the D1 harness in tests/legacy-tier-aliases.test.mjs,
  tests/admin-reads-on-d1.test.mjs and tests/tier-rename-d1-hand-run.test.mjs:
  node:sqlite standing in for the D1 binding, with every migration replayed in
  order so the schema this runs against -- CHECK constraints included -- is
  the one D1 actually enforces, rather than a hand-described approximation of
  it. bind() does no counting of its own; it simply hands its values on to
  node:sqlite's run/get/all, which is what makes the class of bug this file
  guards against surface as a thrown error instead of a silent success. See
  the first test below for why that forwarding is safe to rely on.
*/
function runtimeD1(database) {
  const execute = (statement) => {
    const result = database.prepare(statement.sql).run(...statement.values);
    return { success: true, results: [], meta: { changes: Number(result.changes ?? 0) } };
  };
  const bound = (sql, values) => ({
    sql,
    values,
    async run() { return execute({ sql, values }); },
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
    // D1's batch() is one atomic unit; a real transaction is what makes the
    // reproduction below match production -- the app_users insert has to
    // roll back with the credentials insert it shares a batch with, so the
    // catch block's re-read of app_users finds nothing, not a dangling row.
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(execute);
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function freshD1() {
  const database = new DatabaseSync(":memory:");
  const dir = join(ROOT, "cloudflare", "migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(dir, file), "utf8"));
  }
  return database;
}

function fakeR2() {
  return { async put() {}, async get() { return null; }, async delete() {} };
}

/** Stands in for the `EMAIL` Cloudflare binding; records every message handed to it. */
function fakeEmailBinding() {
  const sent = [];
  return { sent, async send(message) { sent.push(message); } };
}

/*
  Object.assign(process.env, { X: undefined }) would set X to the three
  -character string "undefined" rather than deleting it -- process.env
  stringifies whatever it is assigned. RESEND_API_KEY has to actually be
  absent below for emailSender() to choose the Cloudflare binding path over
  Resend's, so setup deletes an explicit `undefined` the same way restore does.
*/
async function withEnv(values, work) {
  const saved = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await work();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("sanity check: this file's D1 fake leans on node:sqlite's own bind-count validation, not one of its own", async () => {
  /*
    Confirmed empirically: binding three values to a two-placeholder
    statement throws a plain Error ("column index out of range"), not the
    RangeError a reasonable guess might expect -- what this file needs is
    only that it throws at all. If a future Node version ever started
    silently ignoring the extra value instead, this assertion would fail,
    and bind() above would need to count the `?` in its own SQL and throw on
    mismatch itself, the way D1 does, rather than trusting node:sqlite to.
  */
  const probe = runtimeD1(new DatabaseSync(":memory:"));
  const overBound = probe.prepare("SELECT ? AS a, ? AS b").bind(1, 2, 3);
  await assert.rejects(() => overBound.first());
});

test("startNativePasswordRegistration writes a user, a pending bcrypt credential and a confirmation token, and resends rather than duplicating on a second call", async () => {
  await withEnv({ GOOGLE_OAUTH_APP_ORIGIN: "https://bandup.example.test", RESEND_API_KEY: undefined }, async () => {
    const database = freshD1();
    const sender = fakeEmailBinding();
    const bindings = { db: runtimeD1(database), files: fakeR2(), email: sender };
    const email = "new-learner@example.test";
    const now = Date.UTC(2026, 8, 1, 12, 0, 0);

    const created = await startNativePasswordRegistration(email, "a long enough BandUp password", bindings, now);
    assert.equal(created, true);

    const users = database.prepare("SELECT * FROM app_users WHERE email = ?").all(email);
    assert.equal(users.length, 1, "exactly one app_users row for the address");
    const [user] = users;
    assert.equal(user.identity_authority, "cloudflare");

    const credentials = database.prepare("SELECT * FROM app_password_credentials WHERE user_id = ?").all(user.id);
    assert.equal(credentials.length, 1, "exactly one credential row");
    const [credential] = credentials;
    assert.equal(credential.status, "pending");
    assert.equal(credential.scheme, "bcrypt");
    assert.equal(credential.migration_source, "native_registration");
    assert.equal(credential.verifier.length, 60);
    assert.equal(credential.verifier.slice(0, 2), "$2");

    const tokens = database.prepare("SELECT * FROM app_email_action_tokens WHERE user_id = ?").all(user.id);
    assert.equal(tokens.length, 1, "exactly one confirmation token");
    const [token] = tokens;
    assert.equal(token.action, "confirm_registration");
    assert.equal(token.expires_at, new Date(now + 60 * 60 * 1000).toISOString(), "a one-hour lifetime");

    assert.equal(sender.sent.length, 1, "one confirmation email sent");
    const [message] = sender.sent;
    assert.equal(message.to, email);
    assert.equal(message.from, "BandUp <accounts@bandup.life>");
    assert.match(message.text, /https:\/\/bandup\.example\.test\/account\/callback\//);
    assert.ok(
      message.text.includes(`email_token=${token.id}.`),
      "the email must carry the confirmation URL with this token's id",
    );

    // The same address again: the pending row must be resent, not duplicated.
    const again = await startNativePasswordRegistration(email, "a long enough BandUp password", bindings, now + 60_000);
    assert.equal(again, true);
    assert.equal(sender.sent.length, 2, "the resend sends a second email");
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM app_users WHERE email = ?").get(email).n,
      1,
      "no second user is created for the same address",
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM app_password_credentials WHERE user_id = ?").get(user.id).n,
      1,
      "no second credential row either",
    );
  });
});

test("the app_password_credentials INSERT's placeholder count matches its bind() argument count", () => {
  /*
    Read as source text rather than replayed through the D1 fake above, so
    this keeps catching the exact mistake fixed here even if that fake's own
    plumbing ever changes shape.
  */
  const source = readFileSync(join(ROOT, "lib", "auth", "native-email.ts"), "utf8");
  const needle = "INSERT INTO app_password_credentials";
  const insertStart = source.indexOf(needle);
  assert.notEqual(insertStart, -1, "expected to find the credentials insert by name");
  assert.equal(
    source.indexOf(needle, insertStart + 1),
    -1,
    "expected exactly one credentials insert -- this check assumes there is only one to scope to",
  );

  const bindStart = source.indexOf(".bind(", insertStart);
  assert.notEqual(bindStart, -1, "expected the insert to be immediately followed by a .bind(...) call");
  const placeholderCount = (source.slice(insertStart, bindStart).match(/\?/g) ?? []).length;

  let depth = 1;
  let i = bindStart + ".bind(".length;
  while (depth > 0 && i < source.length) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") depth -= 1;
    i += 1;
  }
  assert.equal(depth, 0, "expected the .bind( call to close before the end of the file");
  const argsText = source.slice(bindStart + ".bind(".length, i - 1).trim();

  // Top-level commas only, so an argument that were itself a call would not
  // be miscounted as more than one argument.
  let argCount = argsText ? 1 : 0;
  let nesting = 0;
  for (const character of argsText) {
    if (character === "(" || character === "[" || character === "{") nesting += 1;
    else if (character === ")" || character === "]" || character === "}") nesting -= 1;
    else if (character === "," && nesting === 0) argCount += 1;
  }

  assert.equal(
    argCount,
    placeholderCount,
    `the insert names ${placeholderCount} placeholder(s) but .bind() passes ${argCount} value(s) -- `
    + "this exact mismatch made every native sign-up answer false (a 503) in production",
  );
});
