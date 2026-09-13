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

  Several reported survivors are not killed here because they are genuinely
  equivalent, each for a reason specific to this file:

    - appOrigin()'s own `assertServerOnly(MODULE)` call (line 105). It is a
      private function reachable only through sendActionEmail(), which is
      reachable only from resendPendingRegistration(), startNativePassword
      Registration() and startNativeAccountRecovery() -- and the latter two
      (the only exported entry points in that chain) already call
      assertServerOnly(MODULE) as their own first, synchronous statement,
      before any `await`. So by the time control reaches appOrigin(), either
      the outer call already threw (if `window` was defined) or `window` is
      still undefined (nothing in between sets it) -- the inner call can
      never observe a different `window` than the outer one already did.
    - parseNativeEmailActionToken's outer length gate, `value.length < 54`
      and `value.length > 256` (line 80, 4 mutants). The id half must be
      exactly 36 characters (the UUID regex is fixed-width) and the secret
      half 32-128 (line 86's own regex), so the only lengths that can ever
      reach a non-null result are 69-165 -- comfortably inside 54-256 in
      both directions. Weakening or dropping this gate cannot change the
      outcome for any input, because the two inner regexes independently
      enforce a tighter bound.
    - The dot-position guard, `first < 1 || first !== value.lastIndexOf(".")`
      (line 82, all 5 mutants). The one input that would otherwise
      distinguish "no dot found" (first === -1) from "correctly refused" --
      exploiting how `value.slice(0, -1)` behaves -- needs the whole string
      to be exactly 37 characters for the sliced id to land back on a valid
      36-character UUID. But 37 is already refused by the (real, unmutated)
      length gate above, which requires at least 54. So this guard's only
      possible failure mode is unreachable in combination with the gate
      before it, the same way the length gate is unreachable on its own.
    - `row.action !== action` in consumeNativeEmailAction (line 291). The
      row was already selected `WHERE ... AND action = ?` bound to this same
      `action` value two lines above -- any row the query can possibly
      return already has `row.action === action`, so this equality can never
      observe anything else. It is a defensive restatement of what the SQL
      already guaranteed, not a check with its own reachable failure.
    - `if (!verifier) return false;` in startNativePasswordRegistration
      (line 200). By this point `password.length` is already guaranteed to
      be 8-200 (line 188's own gate, checked moments earlier), which is
      exactly the range hashNativePassword's own guard also accepts --
      and bcryptjs's hash() (see tests/native-password-mutation.test.mjs's
      equivalence note on the same library) does not throw for any password
      *content* in that range. So hashNativePassword cannot return null here
      for any input that reaches this line.
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

test("parseNativeEmailActionToken requires exactly one dot", () => {
  // `first !== value.lastIndexOf(".")` is what a second dot is refused by.
  assert.equal(
    nativeEmail.parseNativeEmailActionToken(`${UUID_A}.${"A".repeat(32)}.extra`),
    null,
    "a second dot",
  );
  // No dot at all, and a leading dot, are both refused too -- see the
  // module-level equivalence note above for why line 82's own mutants
  // cannot be distinguished from these (the length gate ahead of it
  // already forecloses the one input that would).
  assert.equal(nativeEmail.parseNativeEmailActionToken(`${UUID_A}${"A".repeat(32)}`), null, "no dot at all");
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

test("parseNativeEmailActionToken's id regex is anchored to the whole id half, not a substring of it", () => {
  const secret32 = "A".repeat(32);
  // Dropping the leading `^` would let the regex match starting after
  // leading junk; dropping the trailing `$` would let it match while
  // ignoring trailing junk. Both are constructed so the id half, taken as a
  // whole 37-character string, is itself well past the 32-character secret
  // floor and well short of the 128 ceiling -- only the anchor decides these.
  assert.equal(
    nativeEmail.parseNativeEmailActionToken(`X${UUID_A}.${secret32}`),
    null,
    "leading junk before an otherwise-valid uuid must not be tolerated",
  );
  assert.equal(
    nativeEmail.parseNativeEmailActionToken(`${UUID_A}X.${secret32}`),
    null,
    "trailing junk after an otherwise-valid uuid must not be tolerated",
  );
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
/* isLiveUser and sendActionEmail's own failure mode                       */
/* ---------------------------------------------------------------------- */

test("isLiveUser's own deleted_at check rejects a soft-deleted row even if a caller's SQL ever stopped filtering it", async () => {
  // Every real query in this file already filters `deleted_at IS NULL` at
  // the SQL level, so a soft-deleted row never actually reaches isLiveUser()
  // through them -- this is exactly why the check is defence in depth. A
  // fake D1 stands in here so a row with deleted_at set can reach it anyway,
  // the same way a future regression that dropped the SQL-level filter would.
  const user = {
    id: UUID_A, email: "soft-deleted@example.test", created_at: "2026-01-01T00:00:00.000Z", deleted_at: "2026-02-01T00:00:00.000Z", status: "active",
  };
  const sender = fakeEmailBinding();
  const bindings = {
    db: {
      prepare(sql) {
        if (/FROM app_users/.test(sql)) return { bind: () => ({ async first() { return user; } }) };
        return { bind: () => ({}) };
      },
    },
    email: sender,
  };
  await withEnv(APP_ORIGIN_ENV, async () => {
    assert.equal(await nativeEmail.startNativeAccountRecovery(user.email, bindings), true);
    assert.equal(sender.sent.length, 0, "a soft-deleted row must never receive a recovery email, regardless of what the SQL filter would have done");
  });
});

test("sendActionEmail's 'unavailable' failure surfaces with its own exact message when there is no app origin configured", async () => {
  const { bindings } = fixture(); // no APP_ORIGIN_ENV: GOOGLE_OAUTH_APP_ORIGIN is unset here
  await assert.rejects(
    () => nativeEmail.startNativePasswordRegistration("new-person@example.test", "a long enough password", bindings),
    /Email sending is unavailable/,
  );
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

test("startNativePasswordRegistration's boundary values (254-char email, 8- and 200-char password) are let through to D1, not refused", async () => {
  // The poisoned bindings throw the moment anything queries D1 -- a `>`
  // vs `>=` (or `<` vs `<=`) mutant at exactly these lengths would refuse
  // the input outright instead, which resolves to `false`, not a rejection.
  const poisoned = { db: { prepare() { throw new Error("boundary value must reach D1, not be refused first"); } } };
  const email254 = `${"a".repeat(241)}@example.test`; // exactly 254 characters
  assert.equal(email254.length, 254);
  for (const [email, password] of [
    [email254, "a long enough password"],
    ["person@example.test", "8-chars!"],
    ["person@example.test", "p".repeat(200)],
  ]) {
    await assert.rejects(
      () => nativeEmail.startNativePasswordRegistration(email, password, poisoned),
      /boundary value must reach D1/,
      JSON.stringify({ email, password }),
    );
  }
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

test("startNativePasswordRegistration returns false (not true) if the account_users/credentials batch itself reports a partial failure", async () => {
  // A real D1 batch is atomic (all rows share one transaction), so getting a
  // genuine "one write succeeded, one failed" result needs a fake db --
  // this is exactly the shape `writes.some((write) => !write.success)`
  // exists to catch, distinct from the batch throwing outright (the race
  // path, covered above).
  const bindings = {
    db: {
      prepare(sql) {
        if (/FROM app_users/.test(sql)) return { bind: () => ({ async first() { return null; } }) }; // no existing row
        return { bind: () => ({}) };
      },
      async batch(statements) {
        assert.equal(statements.length, 2);
        return [{ success: true }, { success: false }];
      },
    },
    email: fakeEmailBinding(),
  };
  const result = await nativeEmail.startNativePasswordRegistration("new@example.test", "a long enough password", bindings);
  assert.equal(result, false);
});

test("startNativePasswordRegistration returns false when a raced insert's re-read finds no row at all", async () => {
  // The catch branch's re-read can come back empty if the row that won the
  // race was itself removed (or never really existed) by the time this
  // request re-reads -- `if (!raced) return false;` is what answers that
  // case; a fake db forces the INSERT batch to throw and the re-read SELECT
  // to find nothing, which a real D1 fixture cannot reliably reproduce.
  const bindings = {
    db: {
      prepare(sql) {
        if (/FROM app_users/.test(sql)) return { bind: () => ({ async first() { return null; } }) };
        return { bind: () => ({}) };
      },
      async batch() {
        throw new Error("simulated unique-constraint collision");
      },
    },
    email: fakeEmailBinding(),
  };
  const result = await nativeEmail.startNativePasswordRegistration("raced-then-gone@example.test", "a long enough password", bindings);
  assert.equal(result, false);
});

/* ---------------------------------------------------------------------- */
/* Recovery                                                                 */
/* ---------------------------------------------------------------------- */

test("startNativeAccountRecovery refuses malformed input before ever touching D1", async () => {
  const poisoned = { db: { prepare() { throw new Error("must not query D1"); } } };
  assert.equal(await nativeEmail.startNativeAccountRecovery("", poisoned), true);
  assert.equal(await nativeEmail.startNativeAccountRecovery("a".repeat(255), poisoned), true);
});

test("startNativeAccountRecovery's email-length boundary is strictly greater-than 254, not >=254", async () => {
  // A `>` -> `>=` mutant would refuse this exact length outright (resolving
  // to `true` with nothing queried); real code must reach D1 for it.
  const poisoned = { db: { prepare() { throw new Error("a 254-character email must reach D1, not be refused first"); } } };
  const email254 = `${"a".repeat(241)}@example.test`;
  assert.equal(email254.length, 254);
  await assert.rejects(() => nativeEmail.startNativeAccountRecovery(email254, poisoned), /must reach D1/);
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

/**
 * A real D1 fixture (real user, real credential, real issued token) whose
 * `batch()` is patched to return a caller-supplied result instead of
 * actually running the two UPDATEs -- so the underlying rows stay exactly
 * as issueRealToken and insertUser/insertCredential left them (in
 * particular, the user stays live), and only what consumeNativeEmailAction's
 * own post-batch check decides is under test.
 */
async function fixtureWithPatchedBatch(action, batchResult) {
  const { database, bindings } = fixture();
  await insertUser(database, { id: UUID_A, email: "patched@example.test" });
  insertCredential(database, { userId: UUID_A, status: "pending" });
  const token = await issueRealToken(bindings, UUID_A, action);
  const patched = {
    ...bindings,
    db: {
      ...bindings.db,
      async batch(statements) {
        assert.equal(statements.length, 2);
        return batchResult;
      },
    },
  };
  return { database, bindings: patched, token };
}

test("consumeNativeEmailAction returns null if the FIRST write reports the wrong row count, even though nothing else looks wrong", async () => {
  const { bindings, token } = await fixtureWithPatchedBatch("confirm_registration", [
    { success: true, meta: { changes: 0 } },
    { success: true, meta: { changes: 1 } },
  ]);
  // Also the BlockStatement case: the user this token names is still live
  // and untouched (the patched batch never really ran), so a mutant that
  // empties this if-body would fall through and return a real session
  // instead of null.
  assert.equal(await nativeEmail.consumeNativeEmailAction(token, "confirm", "secret", bindings), null);
});

test("consumeNativeEmailAction returns null if the SECOND write reports the wrong row count", async () => {
  const { bindings, token } = await fixtureWithPatchedBatch("confirm_registration", [
    { success: true, meta: { changes: 1 } },
    { success: true, meta: { changes: 0 } },
  ]);
  assert.equal(await nativeEmail.consumeNativeEmailAction(token, "confirm", "secret", bindings), null);
});

test("consumeNativeEmailAction returns null if either write reports failure, even when its own row count looks fine", async () => {
  // success: false on the first write, but with a (deliberately
  // inconsistent) changes: 1 -- isolates detecting the failure itself
  // (`.some`, not `.every` or an arrow function that always returns
  // falsy) from the meta.changes checks beside it, and the two
  // `(A || B) [op] C` groupings from each other.
  const { bindings, token } = await fixtureWithPatchedBatch("confirm_registration", [
    { success: false, meta: { changes: 1 } },
    { success: true, meta: { changes: 1 } },
  ]);
  assert.equal(await nativeEmail.consumeNativeEmailAction(token, "confirm", "secret", bindings), null);
});

test("consumeNativeEmailAction handles a batch result shorter than expected without throwing a different error", async () => {
  // An empty (or one-element) batch result leaves writes[0] (or writes[1])
  // undefined -- the optional chaining is what turns that into a safe
  // `undefined !== 1` (true, correctly refused) instead of a crash reading
  // `.meta` off undefined.
  const empty = await fixtureWithPatchedBatch("confirm_registration", []);
  assert.equal(await nativeEmail.consumeNativeEmailAction(empty.token, "confirm", "secret", empty.bindings), null);

  const oneOnly = await fixtureWithPatchedBatch("recover_access", [{ success: true, meta: { changes: 1 } }]);
  assert.equal(await nativeEmail.consumeNativeEmailAction(oneOnly.token, "recover", "secret", oneOnly.bindings), null);
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

test("issueAction throws (its own error, not a raw TypeError) if the batch result is shorter than expected", async () => {
  // A batch result with only one element leaves `writes[1]` undefined --
  // the optional chaining is what turns that into a safe `undefined !== 1`
  // (true, correctly treated as failure) instead of a crash reading `.meta`
  // off undefined, which would reject with a different, uncontrolled error.
  const user = {
    id: UUID_A, email: "active-short-batch@example.test", created_at: "2026-01-01T00:00:00.000Z", deleted_at: null, status: "active",
  };
  const bindings = {
    db: {
      prepare(sql) {
        if (/FROM app_users/.test(sql)) return { bind: () => ({ async first() { return user; } }) };
        return { bind: () => ({}) };
      },
      async batch() { return [{ success: true, meta: { changes: 1 } }]; },
    },
    email: fakeEmailBinding(),
  };
  await assert.rejects(
    () => nativeEmail.startNativeAccountRecovery(user.email, bindings),
    /native email action could not be stored/,
  );
});

test("issueAction throws if the FIRST batch statement fails, even though the second one alone would look fine", async () => {
  // Isolates `writes.some((write) => !write.success)` from the meta.changes
  // check next to it: the second write reports a clean success with
  // changes=1, so only correctly detecting the first write's failure (not
  // `.every`, and not an arrow function that always returns falsy) explains
  // a throw here.
  const user = {
    id: UUID_B, email: "active-two@example.test", created_at: "2026-01-01T00:00:00.000Z", deleted_at: null, status: "active",
  };
  const bindings = {
    db: {
      prepare(sql) {
        if (/FROM app_users/.test(sql)) return { bind: () => ({ async first() { return user; } }) };
        return { bind: () => ({}) };
      },
      async batch(statements) {
        assert.equal(statements.length, 2);
        return [{ success: false, meta: { changes: 0 } }, { success: true, meta: { changes: 1 } }];
      },
    },
    email: fakeEmailBinding(),
  };
  await assert.rejects(
    () => nativeEmail.startNativeAccountRecovery(user.email, bindings),
    /native email action could not be stored/,
  );
});
