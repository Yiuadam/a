/*
  lib/auth/native-password.ts verifies and creates the bcrypt verifiers used
  by Cloudflare-native sign-in for accounts imported from Supabase. Its
  guards exist to keep a malformed or oversized input from turning into
  either a wrong answer or an unbounded amount of Worker CPU spent inside
  bcryptjs -- so several tests below deliberately construct a *real*,
  correctly-hashed bcrypt verifier at the exact boundary (via bcryptjs
  directly, at a low cost factor purely for test speed) and prove the guard
  still refuses it, rather than merely checking that an obviously-wrong
  input is refused. A boundary case that would otherwise "match" if the
  guard did not run is the only way to prove the guard -- not a downstream
  bcrypt mismatch -- is what produced the refusal.

  Two reported survivors are not killed here because they are genuinely
  equivalent:

    - line 73, `catch { return false; }`'s `false -> true`: reading
      node_modules/bcryptjs's own compareSync/compare/_hash/_crypt, the only
      things that ever throw are (a) a non-string argument -- foreclosed by
      this function's own `string` parameter types and the `!password`
      check, (b) `hash.length !== 60` -- foreclosed by
      isImportedBcryptVerifier's regex, which only accepts exactly 60
      characters, (c) an invalid salt version/revision -- foreclosed by the
      same regex requiring `$2[aby]$`, and (d) rounds outside 4-31 --
      foreclosed by the regex's `0[4-9]|1[0-4]`, well inside that range. Once
      `verifier` has passed isImportedBcryptVerifier, compare() cannot throw
      for any password string short enough to pass the length check either
      (bcryptjs never throws on password *content*, including empty
      strings, embedded NULs, or unpaired surrogates -- it just hashes
      whatever bytes it gets). So the catch block has no reachable input.
    - BOGUS_BCRYPT_VERIFIER's exact 60-character content (its StringLiteral
      survivor -> "") cannot be distinguished by return value at all: it is
      only ever substituted in when `activeVerifier` is already false, and
      `if (!row || !activeVerifier || !matched) return null;` returns null
      from the `!activeVerifier` disjunct regardless of what `matched` came
      out to. Its entire purpose, stated in the source comment, is a timing
      property -- making the "no such account" path cost about the same as
      a real "wrong password" check -- so the one test below that exercises
      it necessarily asserts on elapsed time, not a boolean.
*/
import assert from "node:assert/strict";
import { hash as bcryptHash } from "bcryptjs";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { freshD1, runtimeD1, withBrowserWindow } from "./lib-auth-mutation-helpers.mjs";

register("./alias-resolve.mjs", import.meta.url);

const ROOT = process.cwd();
const load = (...parts) => import(pathToFileURL(join(ROOT, ...parts)).href);
const nativePassword = await load("lib", "auth", "native-password.ts");

const SIGNING_KEY = "a dedicated native-password mutation test secret";

/** A real, valid-format bcrypt verifier for `password`, at the lowest
    accepted cost purely so these boundary tests run quickly. */
async function realVerifierFor(password) {
  const verifier = await bcryptHash(password, 4);
  assert.equal(nativePassword.isImportedBcryptVerifier(verifier), true, "test setup: expected a valid-format verifier");
  return verifier;
}

test("assertServerOnly guards every exported entry point, naming this exact module", async () => {
  await withBrowserWindow(async () => {
    await assert.rejects(
      () => nativePassword.verifyImportedBcryptPassword("password", "$2b$10$".padEnd(60, "A")),
      /lib\/auth\/native-password\.ts is server-only/,
    );
    await assert.rejects(
      () => nativePassword.hashNativePassword("a password"),
      /lib\/auth\/native-password\.ts is server-only/,
    );
    await assert.rejects(
      () => nativePassword.signInWithImportedNativePassword("a@example.test", "password", SIGNING_KEY),
      /lib\/auth\/native-password\.ts is server-only/,
    );
  });
});

test("verifyImportedBcryptPassword refuses an empty password even against a verifier that would otherwise match it", async () => {
  // If the `!password` guard were bypassed (the whole-condition -> false
  // mutant, or the logical-AND mutant with a valid-format verifier), this
  // verifier genuinely matches an empty password -- so a bypass would
  // return true, not false.
  const verifierForEmpty = await realVerifierFor("");
  assert.equal(await nativePassword.verifyImportedBcryptPassword("", verifierForEmpty), false);
});

test("verifyImportedBcryptPassword's 200-character limit refuses 201 but accepts exactly 200", async () => {
  const password200 = "p".repeat(200);
  const password201 = "p".repeat(201);
  const verifier200 = await realVerifierFor(password200);
  const verifier201 = await realVerifierFor(password201);

  // Exactly 200: a `>` -> `>=` mutant would refuse this, even though it is a
  // real match.
  assert.equal(await nativePassword.verifyImportedBcryptPassword(password200, verifier200), true);
  // 201: must be refused before bcrypt ever runs -- proven by using a
  // verifier that WOULD match, so only the guard explains a `false` here.
  assert.equal(await nativePassword.verifyImportedBcryptPassword(password201, verifier201), false);
});

test("verifyImportedBcryptPassword rejects a verifier failing isImportedBcryptVerifier's format check", async () => {
  assert.equal(await nativePassword.verifyImportedBcryptPassword("password", "not-a-bcrypt-verifier"), false);
});

test("hashNativePassword refuses an empty or 201-character password, but accepts exactly 200", async () => {
  // Unlike verifyImportedBcryptPassword, there is no "real match" needed
  // here: hashNativePassword either returns a fresh, valid verifier or it
  // returns null, and bcryptjs's own hash() never throws on password
  // content -- so a guard bypass is directly visible as "returns a verifier
  // instead of null".
  assert.equal(await nativePassword.hashNativePassword(""), null);
  assert.equal(await nativePassword.hashNativePassword("p".repeat(201)), null);

  const atLimit = await nativePassword.hashNativePassword("p".repeat(200));
  assert.notEqual(atLimit, null);
  assert.equal(nativePassword.isImportedBcryptVerifier(atLimit), true);
  assert.equal(await nativePassword.verifyImportedBcryptPassword("p".repeat(200), atLimit), true);
});

test("hashNativePassword's verifier always satisfies isImportedBcryptVerifier (the fixed cost 10 stays in bounds)", async () => {
  const verifier = await nativePassword.hashNativePassword("an ordinary BandUp password");
  assert.equal(verifier.length, 60);
  assert.match(verifier, /^\$2b\$10\$/);
});

/** Poisoned D1 bindings: any query at all is a test failure, proving a
    guard short-circuited before ever reaching the database. */
function unreachableBindings() {
  return {
    db: {
      prepare() {
        throw new Error("must not query D1 -- an early guard should have refused first");
      },
      async batch() {
        throw new Error("must not batch-write D1 -- an early guard should have refused first");
      },
    },
  };
}

test("signInWithImportedNativePassword's own guard refuses malformed input before ever touching D1", async () => {
  const bindings = unreachableBindings();
  for (const [email, password, secret] of [
    ["", "password", SIGNING_KEY],
    ["a".repeat(255), "password", SIGNING_KEY],
    ["person@example.test", "", SIGNING_KEY],
    ["person@example.test", "p".repeat(201), SIGNING_KEY],
    ["person@example.test", "password", ""],
  ]) {
    assert.equal(
      await nativePassword.signInWithImportedNativePassword(email, password, secret, bindings),
      null,
      JSON.stringify({ email, password, secret }),
    );
  }
});

test("signInWithImportedNativePassword's email-length boundary is strictly greater-than 254, not >=254", async () => {
  const database = freshD1();
  const bindings = { db: runtimeD1(database) };
  const now = Date.UTC(2026, 0, 1);
  const email = `${"a".repeat(241)}@example.test`; // exactly 254 characters
  assert.equal(email.length, 254);
  const password = "a long enough BandUp password";
  const verifier = await bcryptHash(password, 4);
  const userId = "11111111-1111-4111-8111-111111111111";
  const stamp = new Date(now).toISOString();
  database.prepare(`
    INSERT INTO app_users (id, email, role, created_at, updated_at, identity_authority)
    VALUES (?, ?, 'user', ?, ?, 'cloudflare')
  `).run(userId, email, stamp, stamp);
  database.prepare(`
    INSERT INTO app_password_credentials (
      user_id, scheme, verifier, source_updated_at, imported_at, updated_at, status, migration_source
    ) VALUES (?, 'bcrypt', ?, ?, ?, ?, 'active', 'supabase_import')
  `).run(userId, verifier, stamp, stamp, stamp);

  // A `>254` -> `>=254` mutant would refuse this exact length, even though a
  // real, matching credential is on file for it.
  const session = await nativePassword.signInWithImportedNativePassword(email, password, SIGNING_KEY, bindings, now);
  assert.ok(session?.accessToken, "a 254-character email must still be allowed to sign in");
});

test("signInWithImportedNativePassword's own password-length boundary is strictly greater-than 200, not >=200", async () => {
  const database = freshD1();
  const bindings = { db: runtimeD1(database) };
  const now = Date.UTC(2026, 0, 1);
  const email = "person@example.test";
  const password = "p".repeat(200); // exactly 200 characters
  const verifier = await bcryptHash(password, 4);
  const userId = "22222222-2222-4222-8222-222222222222";
  const stamp = new Date(now).toISOString();
  database.prepare(`
    INSERT INTO app_users (id, email, role, created_at, updated_at, identity_authority)
    VALUES (?, ?, 'user', ?, ?, 'cloudflare')
  `).run(userId, email, stamp, stamp);
  database.prepare(`
    INSERT INTO app_password_credentials (
      user_id, scheme, verifier, source_updated_at, imported_at, updated_at, status, migration_source
    ) VALUES (?, 'bcrypt', ?, ?, ?, ?, 'active', 'supabase_import')
  `).run(userId, verifier, stamp, stamp, stamp);

  // signInWithImportedNativePassword's own outer guard (line 106) checks
  // `password.length > 200` before ever reaching D1 or bcrypt -- a
  // `>` -> `>=` mutant would refuse this exact length outright, even though
  // a real, matching credential is on file for it.
  const session = await nativePassword.signInWithImportedNativePassword(email, password, SIGNING_KEY, bindings, now);
  assert.ok(session?.accessToken, "a 200-character password must still be allowed to sign in");
});

test("signInWithImportedNativePassword records a real D1 write on success: last_verified_at, updated_at and identity_authority", async () => {
  const database = freshD1();
  const bindings = { db: runtimeD1(database) };
  const email = "person@example.test";
  const password = "a long enough BandUp password";
  const verifier = await bcryptHash(password, 4);
  const userId = "11111111-1111-4111-8111-111111111111";
  const createdStamp = "2026-01-01T00:00:00.000Z";
  database.prepare(`
    INSERT INTO app_users (id, email, role, created_at, updated_at, identity_authority)
    VALUES (?, ?, 'user', ?, ?, 'supabase')
  `).run(userId, email, createdStamp, createdStamp);
  database.prepare(`
    INSERT INTO app_password_credentials (
      user_id, scheme, verifier, source_updated_at, imported_at, updated_at, status, migration_source
    ) VALUES (?, 'bcrypt', ?, ?, ?, ?, 'active', 'supabase_import')
  `).run(userId, verifier, createdStamp, createdStamp, createdStamp);

  const now = Date.UTC(2026, 5, 1, 12, 0, 0);
  const session = await nativePassword.signInWithImportedNativePassword(email, password, SIGNING_KEY, bindings, now);
  assert.ok(session?.accessToken);

  // If either UPDATE's template literal were emptied, node:sqlite's
  // prepare("") would throw (failing the call above) or, in the extremely
  // unlikely case it did not, these rows would still show their original
  // untouched values rather than `now`.
  const credential = database.prepare("SELECT last_verified_at, updated_at FROM app_password_credentials WHERE user_id = ?").get(userId);
  assert.equal(credential.last_verified_at, new Date(now).toISOString());
  assert.equal(credential.updated_at, new Date(now).toISOString());

  const user = database.prepare("SELECT identity_authority, updated_at FROM app_users WHERE id = ?").get(userId);
  assert.equal(user.identity_authority, "cloudflare");
  assert.equal(user.updated_at, new Date(now).toISOString());
});

test("a nonexistent account still costs a real bcrypt comparison (BOGUS_BCRYPT_VERIFIER's timing defence)", async () => {
  const database = freshD1();
  const bindings = { db: runtimeD1(database) };
  const start = Date.now();
  const result = await nativePassword.signInWithImportedNativePassword(
    "nobody-has-this-address@example.test",
    "whatever password",
    SIGNING_KEY,
    bindings,
  );
  const elapsed = Date.now() - start;
  assert.equal(result, null);
  // A real cost-10 bcrypt compare measured well over 90ms every time this
  // was tried in this environment (and often several times that); an empty
  // BOGUS_BCRYPT_VERIFIER would fail isImportedBcryptVerifier's format check
  // and return in well under 1ms, with no bcrypt work at all. 50ms is
  // comfortably between the two.
  assert.ok(elapsed >= 50, `expected a real bcrypt comparison to cost at least 50ms, took ${elapsed}ms`);
});
