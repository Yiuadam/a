/*
  What may be a username, and what may not.

  The rule that carries the most weight is the one about "@". The sign-in form
  has a single field and decides what it is looking at by searching for an @:
  with one it is an email address, without one it is a username. If a username
  could contain an @, the two namespaces would overlap and a name could shadow
  somebody's address — so the tests below check that from both directions,
  rather than trusting a regex to have been written the way it reads.

  Uniqueness itself is not tested here, because it is not implemented here. It
  cannot be: two requests a millisecond apart both ask "is this taken?", both
  are told no, and both insert. Only a unique index settles that, which is why
  `usernames.username` is a primary key in supabase/migrations/0011_usernames.sql
  and why nothing in this module offers an availability check — a function that
  answered would be believed, and its answer would be stale before it was read.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

register("./alias-resolve.mjs", import.meta.url);

const { RESERVED_USERNAMES, claimable, isReservedUsername, normaliseUsername } = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "usernames.ts")).href
);
const { generateUsername } = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "generated-username.ts")).href
);

test("a username is lower-cased and trimmed to one canonical form", () => {
  for (const typed of ["Adam", "adam", "  ADAM  ", "aDaM"]) {
    assert.equal(normaliseUsername(typed), "adam", typed);
  }
});

test("nothing containing an @ can ever be a username", () => {
  for (const typed of ["a@b.com", "@adam", "adam@", "ad@m", " someone@example.com "]) {
    assert.equal(normaliseUsername(typed), null, typed);
  }
});

test("the shape rules are enforced", () => {
  /* Too short, too long, bad first character, illegal characters, spaces. */
  for (const bad of [
    "ab", "", "   ", ".adam", "-adam", "_adam", "ad am", "adam!", "adam/1",
    "a".repeat(31), "adam x",
  ]) {
    assert.equal(normaliseUsername(bad), null, JSON.stringify(bad));
  }
  for (const good of ["abc", "adam", "a1", "a_b", "a.b", "a-b", "a".repeat(30), "9lives"]) {
    if (good.length < 3) continue;
    assert.equal(normaliseUsername(good), good, good);
  }
});

test("non-strings are refused rather than coerced", () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.equal(normaliseUsername(bad), null, String(bad));
  }
});

test("reserved names cover roles and routes, and are all valid names", () => {
  for (const name of ["admin", "support", "billing", "root", "bandup", "www"]) {
    assert.equal(isReservedUsername(name), true, name);
  }
  assert.equal(isReservedUsername("adam"), false);
  /* A reserved name that is not a legal username would reserve nothing. */
  for (const name of RESERVED_USERNAMES) {
    assert.equal(normaliseUsername(name), name, `${name} is not a legal username`);
  }
});

test("claiming refuses shape, reserved names and the owner's own", () => {
  assert.deepEqual(claimable("Sam99", null), { ok: true, username: "sam99" });
  assert.deepEqual(claimable("s", null), { ok: false, reason: "shape" });
  assert.deepEqual(claimable("me@example.com", null), { ok: false, reason: "shape" });
  assert.deepEqual(claimable("Support", null), { ok: false, reason: "reserved" });
  /* The owner's name is unavailable, and is reported the same way as any other
     reserved name — that it belongs to the owner is not a stranger's business. */
  assert.deepEqual(claimable("ADAM", "adam"), { ok: false, reason: "reserved" });
  assert.deepEqual(claimable("adam", null), { ok: true, username: "adam" });
});

/*
  The database is the copy that cannot be bypassed, so the two must agree. This
  reads the migration rather than trusting them to have been written together.
*/
test("the migration enforces the same shape, and enforces uniqueness", () => {
  const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "0011_usernames.sql"), "utf8");
  assert.match(sql, /username\s+citext primary key/, "username must be the primary key");
  assert.match(sql, /user_id\s+uuid not null unique/, "one name per account");
  const shape = /\^\[a-z0-9\]\[a-z0-9\._-\]\{2,29\}\$/g;
  assert.ok((sql.match(shape) ?? []).length >= 2, "the CHECK and the function must share the shape");
  assert.doesNotMatch(sql, /grant execute[^;]*to (anon|authenticated)/i, "no client may call these");
});

test("generated usernames are friendly, legal and repeatable without personal data", () => {
  const values = [0, 0, 0, 1, 1, 1];
  const random = () => values.shift() ?? 2;
  const first = generateUsername(null, random);
  const second = generateUsername(first, random);
  assert.equal(claimable(first, null).ok, true);
  assert.equal(claimable(second, null).ok, true);
  assert.notEqual(second, first);
  assert.match(first, /^[a-z]+-[a-z]+-[0-9]{3}$/);
  assert.doesNotMatch(first, /@|example|user[_-]?id/i);
});
