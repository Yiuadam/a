/*
  lib/auth/native-email.ts is the whole email confirmation/recovery flow for
  Cloudflare-native accounts: parsing the opaque action token, writing the
  app_users/app_password_credentials/app_email_action_tokens rows, and
  composing the actual email sent. Rather than testing each private helper
  in isolation (most are not exported), this file drives the four exported
  entry points end to end against a real in-memory D1 (node:sqlite, every
  migration replayed -- the same technique tests/native-registration-writes
  .test.mjs uses) and a fake EMAIL binding that records every message handed
  to it, so the exact subject/body/link a mutation could corrupt is asserted
  directly, and every write is checked against the real rows afterwards.

  One reported survivor is not killed here because it is genuinely
  equivalent: appOrigin()'s own `assertServerOnly(MODULE)` call (line 105).
  It is a private function reachable only through sendActionEmail(), which
  is reachable only from resendPendingRegistration(), startNativePassword
  Registration() and startNativeAccountRecovery() -- and the latter two
  (the only exported entry points in that chain) already call
  assertServerOnly(MODULE) as their own first, synchronous statement, before
  any `await`. So by the time control reaches appOrigin(), either the outer
  call already threw (if `window` was defined) or `window` is still
  undefined (nothing in between sets it) -- the inner call can never
  observe a different `window` than the outer one already did.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  fakeEmailBinding, fakeR2, freshD1, runtimeD1, withBrowserWindow, withEnv,
} from "./lib-auth-mutation-helpers.mjs";

register("./alias-resolve.mjs", import.meta.url);

const ROOT = process.cwd();
const load = (...parts) => import(pathToFileURL(join(ROOT, ...parts)).href);
const nativeEmail = await load("lib", "auth", "native-email.ts");

const APP_ORIGIN_ENV = { GOOGLE_OAUTH_APP_ORIGIN: "https://bandup.example.test", RESEND_API_KEY: undefined };

function fixture() {
  const database = freshD1();
  const sender = fakeEmailBinding();
  const bindings = { db: runtimeD1(database), files: fakeR2(), email: sender };
  return { database, sender, bindings };
}

async function insertUser(database, { id, email, createdAt = "2026-01-01T00:00:00.000Z", deletedAt = null }) {
  database.prepare(`
    INSERT INTO app_users (id, email, role, created_at, updated_at, identity_authority, deleted_at)
    VALUES (?, ?, 'user', ?, ?, 'cloudflare', ?)
  `).run(id, email, createdAt, createdAt, deletedAt);
}

function insertCredential(database, { userId, verifier = "$2b$10$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", status, at = "2026-01-01T00:00:00.000Z" }) {
  database.prepare(`
    INSERT INTO app_password_credentials (
      user_id, scheme, verifier, source_updated_at, imported_at, updated_at, status, migration_source
    ) VALUES (?, 'bcrypt', ?, ?, ?, ?, ?, 'native_registration')
  `).run(userId, verifier, at, at, at, status);
}

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

/* ---------------------------------------------------------------------- */
/* assertServerOnly                                                        */
/* ---------------------------------------------------------------------- */

test("assertServerOnly guards every exported entry point that has one, naming this exact module", async () => {
  await withBrowserWindow(async () => {
    await assert.rejects(
      () => nativeEmail.startNativePasswordRegistration("a@example.test", "a long enough password"),
      /lib\/auth\/native-email\.ts is server-only/,
    );
    await assert.rejects(
      () => nativeEmail.startNativeAccountRecovery("a@example.test"),
      /lib\/auth\/native-email\.ts is server-only/,
    );
    await assert.rejects(
      () => nativeEmail.consumeNativeEmailAction("x", "confirm", "secret"),
      /lib\/auth\/native-email\.ts is server-only/,
    );
  });
});

/* ---------------------------------------------------------------------- */
/* parseNativeEmailActionToken                                             */
/* ---------------------------------------------------------------------- */

test("parseNativeEmailActionToken accepts the ordinary shape and rejects non-string input", () => {
  const uuid = UUID_A;
  const secret32 = "A".repeat(32);
  const validToken = `${uuid}.${secret32}`; // 36 + 1 + 32 = 69 characters
  assert.equal(validToken.length, 69);
  assert.deepEqual(nativeEmail.parseNativeEmailActionToken(validToken), { id: uuid, token: validToken });

  for (const value of [undefined, null, 12345, {}, []]) {
    assert.equal(nativeEmail.parseNativeEmailActionToken(value), null, String(value));
  }

  // Upper length bound: the secret charset allows up to 128 characters, so a
  // comfortably valid token can still be well under 256 overall.
  const tokenNear165 = `${uuid}.${"A".repeat(128)}`; // 36 + 1 + 128 = 165
  assert.notEqual(nativeEmail.parseNativeEmailActionToken(tokenNear165), null);
});

test("parseNativeEmailActionToken requires exactly one dot, and rejects a dot-free string that would otherwise slice into a valid shape", () => {
  // `first !== value.lastIndexOf(".")` is what a second dot is refused by.
  assert.equal(
    nativeEmail.parseNativeEmailActionToken(`${UUID_A}.${"A".repeat(32)}.extra`),
    null,
    "a second dot",
  );

  /*
    `first < 1` (first = value.indexOf(".")) matters only for the "no dot at
    all" case (first === -1) -- and only because of how negative-index
    .slice() behaves, not because the id or secret half would otherwise be
    obviously wrong-shaped. With no dot, id = value.slice(0, -1) (everything
    but the last character) and secret = value.slice(0) (the whole string,
    since first + 1 === 0). For most dot-free strings both halves come out
    the wrong length and fail their own regexes regardless of this check --
    but a 37-character, dot-free string built as a valid 36-character UUID
    plus one trailing character defeats that: slice(0, -1) reconstructs
    exactly the valid UUID, and the whole 37-character string (the UUID's
    own hyphens are within [A-Za-z0-9_-]) also happens to satisfy the
    secret's own 32-128 charset-and-length regex. That is the one input
    where `first < 1` is the sole reason the token is refused -- a `-> false`
    or whole-condition bypass would accept it.
  */
  const noDotButSliceable = `${UUID_A}X`; // 37 characters, not a single "."
  assert.equal(noDotButSliceable.indexOf("."), -1, "test setup: confirms there really is no dot");
  assert.equal(nativeEmail.parseNativeEmailActionToken(noDotButSliceable), null);

  // A leading dot (first === 0) is refused too, but for an unrelated reason
  // that holds regardless of this exact check: slice(0, 0) is "", which can
  // never satisfy the 36-character UUID regex.
  assert.equal(nativeEmail.parseNativeEmailActionToken(`.${"a".repeat(68)}`), null, "leading dot");
});

test("parseNativeEmailActionToken's id half is a strict UUID (version 1-5, variant 8/9/a/b)", () => {
  const secret32 = "A".repeat(32);
  const validSuffix = (id) => `${id}.${secret32}`;

  // Version nibble must be 1-5.
  for (const version of ["0", "6", "9", "f"]) {
    const id = `11111111-1111-${version}111-8111-111111111111`;
    assert.equal(nativeEmail.parseNativeEmailActionToken(validSuffix(id)), null, `version ${version}`);
  }
  for (const version of ["1", "2", "3", "4", "5"]) {
    const id = `11111111-1111-${version}111-8111-111111111111`;
    assert.notEqual(nativeEmail.parseNativeEmailActionToken(validSuffix(id)), null, `version ${version}`);
  }

  // Variant nibble must be 8, 9, a or b.
  for (const variant of ["0", "7", "c", "f"]) {
    const id = `11111111-1111-4111-${variant}111-111111111111`;
    assert.equal(nativeEmail.parseNativeEmailActionToken(validSuffix(id)), null, `variant ${variant}`);
  }
  for (const variant of ["8", "9", "a", "b"]) {
    const id = `11111111-1111-4111-${variant}111-111111111111`;
    assert.notEqual(nativeEmail.parseNativeEmailActionToken(validSuffix(id)), null, `variant ${variant}`);
  }

  // Case-insensitive, and the id must be exactly the UUID shape (not
  // trailing/leading garbage merged into the secret half by a different dot).
  assert.notEqual(
    nativeEmail.parseNativeEmailActionToken(`11111111-1111-4111-8111-111111111111`.toUpperCase() + `.${secret32}`),
    null,
    "uppercase hex",
  );
  assert.equal(nativeEmail.parseNativeEmailActionToken(`not-a-uuid-at-all-but-69-characters-long-of-content.${secret32}`), null);
});

test("parseNativeEmailActionToken's secret half is 32-128 url-safe characters", () => {
  const uuid = UUID_A;
  assert.equal(nativeEmail.parseNativeEmailActionToken(`${uuid}.${"A".repeat(31)}`), null, "31: one short");
  assert.notEqual(nativeEmail.parseNativeEmailActionToken(`${uuid}.${"A".repeat(32)}`), null, "32: the floor");
  assert.notEqual(nativeEmail.parseNativeEmailActionToken(`${uuid}.${"A".repeat(128)}`), null, "128: the ceiling");
  assert.equal(nativeEmail.parseNativeEmailActionToken(`${uuid}.${"A".repeat(129)}`), null, "129: one over");
  assert.equal(nativeEmail.parseNativeEmailActionToken(`${uuid}.${"A".repeat(32 - 1)}+`), null, "a '+' is not url-safe");
});

/* ---------------------------------------------------------------------- */
/* Registration: composed email content, resend-vs-create, raced insert    */
/* ---------------------------------------------------------------------- */

test("startNativePasswordRegistration refuses malformed input before ever touching D1", async () => {
  const poisoned = {
    db: {
      prepare() { throw new Error("must not query D1 -- the length guard should refuse first"); },
    },
  };
  for (const [email, password] of [
    ["", "a long enough password"],
    ["a".repeat(255), "a long enough password"],
    ["person@example.test", ""],
    ["person@example.test", "1234567"], // 7 characters: one under the 8-char floor
    ["person@example.test", "p".repeat(201)],
  ]) {
    assert.equal(await nativeEmail.startNativePasswordRegistration(email, password, poisoned), false, JSON.stringify({ email, password }));
  }
  // Sanity: the floor itself (8 characters) and the ceiling (200) are allowed
  // through to D1 -- proven by the very next test actually completing.
});

test("startNativePasswordRegistration writes a live confirmation email with the exact link shape and copy", async () => {
  await withEnv(APP_ORIGIN_ENV, async () => {
    const { database, sender, bindings } = fixture();
    const email = "new-learner@example.test";
    const now = Date.UTC(2026, 8, 1, 12, 0, 0);

    const created = await nativeEmail.startNativePasswordRegistration(email, "a long enough BandUp password", bindings, now);
    assert.equal(created, true);
    assert.equal(sender.sent.length, 1);
    const [message] = sender.sent;
    assert.equal(message.to, email);
    assert.equal(message.from, "BandUp <accounts@bandup.life>");
    assert.equal(message.subject, "Confirm your BandUp account");
    assert.match(message.text, /Confirm your email address to finish creating your BandUp account\./);
    assert.doesNotMatch(message.text, /Use this one-time link to sign in/);
    assert.match(message.html, /<p>Confirm your email address to finish creating your BandUp account\.<\/p>/);
    assert.match(message.html, /<a href="[^"]+">Confirm your BandUp account<\/a>/);

    const url = new URL(message.text.match(/https:\/\/\S+/)[0]);
    assert.equal(url.origin, "https://bandup.example.test");
    assert.equal(url.pathname, "/account/callback/");
    assert.equal(url.search, "", "the one-time token must never be a query parameter");
    const hash = new URLSearchParams(url.hash.slice(1));
    assert.equal(hash.get("email_action"), "confirm", "registration's callback action must be 'confirm', not the raw 'confirm_registration'");
    const token = hash.get("email_token");
    assert.ok(token);

    const users = database.prepare("SELECT * FROM app_users WHERE email = ?").all(email);
    assert.equal(users.length, 1);
    const credentials = database.prepare("SELECT * FROM app_password_credentials WHERE user_id = ?").all(users[0].id);
    assert.equal(credentials.length, 1);
    assert.equal(credentials[0].status, "pending");
    const tokens = database.prepare("SELECT * FROM app_email_action_tokens WHERE user_id = ?").all(users[0].id);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].action, "confirm_registration");
    assert.equal(tokens[0].expires_at, new Date(now + 60 * 60 * 1000).toISOString(), "a strictly one-hour lifetime");
    assert.ok(token.startsWith(`${tokens[0].id}.`));
  });
});

test("startNativePasswordRegistration resends (not duplicates) for a pending address, and stays silent for an active one", async () => {
  await withEnv(APP_ORIGIN_ENV, async () => {
    const { database, sender, bindings } = fixture();
    const email = "again@example.test";
    const now = Date.UTC(2026, 8, 1, 12, 0, 0);
    await nativeEmail.startNativePasswordRegistration(email, "a long enough BandUp password", bindings, now);
    assert.equal(sender.sent.length, 1);

    const again = await nativeEmail.startNativePasswordRegistration(email, "a different long password", bindings, now + 60_000);
    assert.equal(again, true);
    assert.equal(sender.sent.length, 2, "a pending address resends a confirmation");
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM app_users WHERE email = ?").get(email).n, 1, "no second user row");
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM app_password_credentials WHERE user_id = (SELECT id FROM app_users WHERE email = ?)").get(email).n,
      1,
      "no second credential row",
    );

    // Now activate the credential (as consumeNativeEmailAction would) and
    // confirm a further "registration" for the same address sends nothing.
    const userId = database.prepare("SELECT id FROM app_users WHERE email = ?").get(email).id;
    database.prepare("UPDATE app_password_credentials SET status = 'active' WHERE user_id = ?").run(userId);
    sender.sent.length = 0;
    const activeRetry = await nativeEmail.startNativePasswordRegistration(email, "yet another password", bindings, now + 120_000);
    assert.equal(activeRetry, true);
    assert.equal(sender.sent.length, 0, "an already-active address must not be resent a confirmation, or reveal anything by resending");
  });
});

test("startNativePasswordRegistration recovers from a racing duplicate insert by re-reading and resending", async () => {
  await withEnv(APP_ORIGIN_ENV, async () => {
    const { database, sender, bindings } = fixture();
    const email = "racer@example.test";
    const now = Date.UTC(2026, 8, 1, 12, 0, 0);

    // Simulate the race directly: another request's INSERT already landed
    // between this request's initial SELECT (which the real code does not
    // re-run here) and its own INSERT attempt -- forced here by pre-existing
    // the row so the real INSERT collides on the unique lower(email) index.
    database.prepare(`
      INSERT INTO app_users (id, email, role, created_at, updated_at, identity_authority)
      VALUES (?, ?, 'user', ?, ?, 'cloudflare')
    `).run(UUID_A, email, new Date(now).toISOString(), new Date(now).toISOString());
    database.prepare(`
      INSERT INTO app_password_credentials (
        user_id, scheme, verifier, source_updated_at, imported_at, updated_at, status, migration_source
      ) VALUES (?, 'bcrypt', ?, ?, ?, ?, 'pending', 'native_registration')
    `).run(UUID_A, "$2b$10$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", new Date(now).toISOString(), new Date(now).toISOString(), new Date(now).toISOString());

    // The bindings passed to startNativePasswordRegistration wrap a D1 whose
    // very first SELECT (the "does this address exist" read) is patched to
    // report nothing, forcing the code down the INSERT -> catch -> re-read path.
    const database2 = database;
    let selects = 0;
    const wrapped = {
      db: {
        prepare(sql) {
          const real = bindings.db.prepare(sql);
          if (/SELECT u\.id, u\.email, u\.created_at, u\.deleted_at, c\.status/.test(sql)) {
            selects += 1;
            if (selects === 1) {
              return { bind: () => ({ async first() { return null; } }) };
            }
          }
          return real;
        },
        batch: (statements) => bindings.db.batch(statements),
      },
      email: bindings.email,
    };
    void database2;

    const result = await nativeEmail.startNativePasswordRegistration(email, "a long enough BandUp password", wrapped, now);
    assert.equal(result, true);
    assert.equal(sender.sent.length, 1, "the raced retry must still resend a confirmation");
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM app_users WHERE email = ?").get(email).n, 1, "still exactly one user row");
  });
});

/* ---------------------------------------------------------------------- */
/* Recovery                                                                 */
/* ---------------------------------------------------------------------- */

test("startNativeAccountRecovery refuses malformed input before ever touching D1", async () => {
  const poisoned = { db: { prepare() { throw new Error("must not query D1"); } } };
  assert.equal(await nativeEmail.startNativeAccountRecovery("", poisoned), true);
  assert.equal(await nativeEmail.startNativeAccountRecovery("a".repeat(255), poisoned), true);
});

test("startNativeAccountRecovery sends nothing for an unknown address, but still returns true (no account enumeration)", async () => {
  await withEnv(APP_ORIGIN_ENV, async () => {
    const { sender, bindings } = fixture();
    const result = await nativeEmail.startNativeAccountRecovery("nobody@example.test", bindings);
    assert.equal(result, true);
    assert.equal(sender.sent.length, 0);
  });
});

test("startNativeAccountRecovery resends a confirmation (not a recovery link) for a still-pending account", async () => {
  await withEnv(APP_ORIGIN_ENV, async () => {
    const { database, sender, bindings } = fixture();
    await insertUser(database, { id: UUID_A, email: "pending@example.test" });
    insertCredential(database, { userId: UUID_A, status: "pending" });

    const result = await nativeEmail.startNativeAccountRecovery("pending@example.test", bindings);
    assert.equal(result, true);
    assert.equal(sender.sent.length, 1);
    assert.equal(sender.sent[0].subject, "Confirm your BandUp account");
    const tokenRow = database.prepare("SELECT action FROM app_email_action_tokens WHERE user_id = ?").get(UUID_A);
    assert.equal(tokenRow.action, "confirm_registration");
  });
});

test("startNativeAccountRecovery sends a real sign-in link for an active account, addressed with 'recover'", async () => {
  await withEnv(APP_ORIGIN_ENV, async () => {
    const { database, sender, bindings } = fixture();
    await insertUser(database, { id: UUID_A, email: "active@example.test" });
    insertCredential(database, { userId: UUID_A, status: "active" });

    const result = await nativeEmail.startNativeAccountRecovery("Active@Example.test", bindings);
    assert.equal(result, true);
    assert.equal(sender.sent.length, 1);
    const [message] = sender.sent;
    assert.equal(message.subject, "Sign in to BandUp");
    assert.match(message.text, /Use this one-time link to sign in to your BandUp account\./);
    assert.doesNotMatch(message.text, /Confirm your email address/);
    const url = new URL(message.text.match(/https:\/\/\S+/)[0]);
    const hash = new URLSearchParams(url.hash.slice(1));
    assert.equal(hash.get("email_action"), "recover");
    const tokenRow = database.prepare("SELECT action FROM app_email_action_tokens WHERE user_id = ?").get(UUID_A);
    assert.equal(tokenRow.action, "recover_access");
  });
});

test("startNativeAccountRecovery treats a deleted or emailless account exactly like an unknown one", async () => {
  await withEnv(APP_ORIGIN_ENV, async () => {
    const { database, sender, bindings } = fixture();
    await insertUser(database, { id: UUID_A, email: "deleted@example.test", deletedAt: "2026-01-02T00:00:00.000Z" });
    insertCredential(database, { userId: UUID_A, status: "active" });

    assert.equal(await nativeEmail.startNativeAccountRecovery("deleted@example.test", bindings), true);
    assert.equal(sender.sent.length, 0);
  });
});

/* ---------------------------------------------------------------------- */
/* consumeNativeEmailAction                                                */
/* ---------------------------------------------------------------------- */

async function issueRealToken(bindings, userId, action) {
  // Drives the real write path (startNativeAccountRecovery/registration
  // already exercise issueAction's shape); here a raw INSERT stands in for
  // it only to get a hashed token deterministically without sending mail --
  // consumeNativeEmailAction's own D1 statements are what is under test.
  const { randomSessionToken, sha256Hex } = await load("lib", "auth", "native-session.ts");
  const id = crypto.randomUUID();
  const token = `${id}.${randomSessionToken(32)}`;
  const now = Date.now();
  const at = new Date(now).toISOString();
  await bindings.db.prepare(`
    INSERT INTO app_email_action_tokens (id, user_id, action, token_sha256, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(id, userId, action, await sha256Hex(token), at, new Date(now + 60 * 60 * 1000).toISOString()).run();
  return token;
}

test("consumeNativeEmailAction rejects a malformed token, an unmapped action string, or a missing signing secret -- before touching D1", async () => {
  const poisoned = { db: { prepare() { throw new Error("must not query D1"); } } };
  assert.equal(await nativeEmail.consumeNativeEmailAction("not-a-real-token", "confirm", "secret", poisoned), null);
  assert.equal(await nativeEmail.consumeNativeEmailAction(`${UUID_A}.${"A".repeat(32)}`, "not-confirm-or-recover", "secret", poisoned), null);
  assert.equal(await nativeEmail.consumeNativeEmailAction(`${UUID_A}.${"A".repeat(32)}`, 42, "secret", poisoned), null, "a non-string expectedAction must not reach emailAction()");
  assert.equal(await nativeEmail.consumeNativeEmailAction(`${UUID_A}.${"A".repeat(32)}`, "confirm", ""), null, "an empty signing secret refuses");
});

test("consumeNativeEmailAction: a valid confirm_registration token activates the credential and issues a session", async () => {
  const { database, bindings } = fixture();
  await insertUser(database, { id: UUID_A, email: "confirmer@example.test" });
  insertCredential(database, { userId: UUID_A, status: "pending" });
  const token = await issueRealToken(bindings, UUID_A, "confirm_registration");

  const session = await nativeEmail.consumeNativeEmailAction(token, "confirm", "a dedicated consume-action test secret", bindings);
  assert.ok(session?.accessToken);
  assert.equal(session.email, "confirmer@example.test");

  assert.equal(database.prepare("SELECT status FROM app_password_credentials WHERE user_id = ?").get(UUID_A).status, "active");
  assert.ok(database.prepare("SELECT consumed_at FROM app_email_action_tokens WHERE user_id = ?").get(UUID_A).consumed_at);

  // One-time: consuming the same token again must fail.
  assert.equal(await nativeEmail.consumeNativeEmailAction(token, "confirm", "a dedicated consume-action test secret", bindings), null);
});

test("consumeNativeEmailAction: a valid recover_access token touches the user and issues a session, without touching credentials status", async () => {
  const { database, bindings } = fixture();
  await insertUser(database, { id: UUID_A, email: "recoverer@example.test" });
  insertCredential(database, { userId: UUID_A, status: "active" });
  const token = await issueRealToken(bindings, UUID_A, "recover_access");
  const beforeUpdatedAt = database.prepare("SELECT updated_at FROM app_users WHERE id = ?").get(UUID_A).updated_at;

  const session = await nativeEmail.consumeNativeEmailAction(token, "recover", "a dedicated consume-action test secret", bindings, Date.now() + 5000);
  assert.ok(session?.accessToken);
  assert.equal(database.prepare("SELECT status FROM app_password_credentials WHERE user_id = ?").get(UUID_A).status, "active");
  assert.notEqual(database.prepare("SELECT updated_at FROM app_users WHERE id = ?").get(UUID_A).updated_at, beforeUpdatedAt);
});

test("consumeNativeEmailAction refuses a token issued for the OTHER action (confirm token used as recover, and vice versa)", async () => {
  const { database, bindings } = fixture();
  await insertUser(database, { id: UUID_A, email: "mismatch@example.test" });
  insertCredential(database, { userId: UUID_A, status: "pending" });
  const confirmToken = await issueRealToken(bindings, UUID_A, "confirm_registration");

  assert.equal(await nativeEmail.consumeNativeEmailAction(confirmToken, "recover", "secret", bindings), null);
  // The token must still be unconsumed and usable for its real action.
  const stillGood = await nativeEmail.consumeNativeEmailAction(confirmToken, "confirm", "secret", bindings);
  assert.ok(stillGood?.accessToken);
});

test("consumeNativeEmailAction refuses an expired token", async () => {
  const { database, bindings } = fixture();
  await insertUser(database, { id: UUID_A, email: "expired@example.test" });
  insertCredential(database, { userId: UUID_A, status: "pending" });
  const token = await issueRealToken(bindings, UUID_A, "confirm_registration");

  const farFuture = Date.now() + 2 * 60 * 60 * 1000; // two hours later: past the one-hour lifetime
  assert.equal(await nativeEmail.consumeNativeEmailAction(token, "confirm", "secret", bindings, farFuture), null);
});

test("consumeNativeEmailAction returns null if the account was deleted between issuing and consuming the token", async () => {
  const { database, bindings } = fixture();
  await insertUser(database, { id: UUID_A, email: "vanishing@example.test" });
  insertCredential(database, { userId: UUID_A, status: "pending" });
  const token = await issueRealToken(bindings, UUID_A, "confirm_registration");
  database.prepare("UPDATE app_users SET deleted_at = ? WHERE id = ?").run("2026-02-01T00:00:00.000Z", UUID_A);

  assert.equal(await nativeEmail.consumeNativeEmailAction(token, "confirm", "secret", bindings), null);
});

test("issueAction throws if its D1 batch does not report exactly one new token row", async () => {
  // A fake bindings object stands in here (rather than real D1) because a
  // real INSERT either succeeds with changes=1 or throws on a constraint --
  // there is no ordinary way to make a genuine SQLite INSERT report success
  // with changes=0, which is exactly the "meta.changes !== 1" edge this line
  // exists to catch. The user lookup is answered directly so
  // startNativeAccountRecovery reaches issueAction with a real, active user.
  const user = {
    id: UUID_A, email: "active@example.test", created_at: "2026-01-01T00:00:00.000Z", deleted_at: null, status: "active",
  };
  const bindings = {
    db: {
      prepare(sql) {
        if (/FROM app_users/.test(sql)) {
          return { bind: () => ({ async first() { return user; } }) };
        }
        return { bind: () => ({}) };
      },
      // issueAction's batch: [UPDATE previous tokens, INSERT new token]. The
      // INSERT (index 1) reports success with zero rows changed -- the
      // exact shape `writes[1]?.meta.changes !== 1` exists to catch.
      async batch(statements) {
        assert.equal(statements.length, 2);
        return [{ success: true, meta: { changes: 1 } }, { success: true, meta: { changes: 0 } }];
      },
    },
    email: fakeEmailBinding(),
  };
  await assert.rejects(
    () => nativeEmail.startNativeAccountRecovery(user.email, bindings),
    /native email action could not be stored/,
  );
});
