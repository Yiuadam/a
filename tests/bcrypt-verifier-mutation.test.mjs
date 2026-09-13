/*
  lib/auth/bcrypt-verifier.ts is one regex, shared by the D1 importer and the
  runtime sign-in verifier: BCRYPT_VERIFIER decides which of Supabase's bcrypt
  verifiers this codebase will ever hand to bcryptjs's compare(). Getting a
  boundary wrong here either rejects a legitimately migrated password (cost 04
  or 14) or lets an oversized-cost verifier through -- exactly the "unbounded
  Worker CPU" case the module comment warns about.

  Every case below is table-driven against isAcceptedBcryptVerifier so the
  accept/reject line is asserted directly, not inferred from a handful of
  spot checks.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const bcrypt = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "bcrypt-verifier.ts")).href
);

// 53 characters, all drawn from the verifier body's own class
// [./A-Za-z0-9], so only the parts under test below vary.
const BODY = "A".repeat(53);
const verifier = (scheme, cost) => `$${scheme}$${cost}$${BODY}`;

test("accepts every scheme letter and cost in the bounded 04-14 range", () => {
  for (const scheme of ["2a", "2b", "2y"]) {
    for (const cost of ["04", "05", "06", "07", "08", "09", "10", "11", "12", "13", "14"]) {
      assert.equal(
        bcrypt.isAcceptedBcryptVerifier(verifier(scheme, cost)),
        true,
        `${scheme}/${cost} should be accepted`,
      );
    }
  }
});

test("rejects a cost outside 04-14, in both directions", () => {
  // 00-03: below the floor. This is the range a mutated `0[^4-9]` would
  // wrongly accept instead of `0[4-9]`, so it is asserted on its own.
  for (const cost of ["00", "01", "02", "03"]) {
    assert.equal(bcrypt.isAcceptedBcryptVerifier(verifier("2b", cost)), false, cost);
  }
  // 15+ and non-numeric: above the ceiling / not a cost at all.
  for (const cost of ["15", "16", "20", "99", "0a", "1a"]) {
    assert.equal(bcrypt.isAcceptedBcryptVerifier(verifier("2b", cost)), false, cost);
  }
});

test("rejects a scheme letter bcrypt never produces", () => {
  for (const scheme of ["2c", "2x", "3b", "1b"]) {
    assert.equal(bcrypt.isAcceptedBcryptVerifier(verifier(scheme, "10")), false, scheme);
  }
});

test("anchors the match to the whole string, not a substring of something longer", () => {
  const valid = verifier("2b", "10");
  assert.equal(bcrypt.isAcceptedBcryptVerifier(valid), true, "sanity: the base case still accepts");
  assert.equal(bcrypt.isAcceptedBcryptVerifier(`x${valid}`), false, "leading junk before $2 must not be tolerated");
  assert.equal(bcrypt.isAcceptedBcryptVerifier(`${valid}x`), false, "trailing junk after the 53rd character must not be tolerated");
  // A 54th character drawn from the body's own class -- proves the anchor is
  // doing the rejecting, not merely a `{53}` that happens to stop early.
  assert.equal(bcrypt.isAcceptedBcryptVerifier(`${valid}A`), false);
});

test("the body must be exactly 53 characters from its own class, no more and no fewer", () => {
  assert.equal(bcrypt.isAcceptedBcryptVerifier(`$2b$10$${"A".repeat(52)}`), false, "52 is one short");
  assert.equal(bcrypt.isAcceptedBcryptVerifier(`$2b$10$${"A".repeat(54)}`), false, "54 is one too many");
  assert.equal(bcrypt.isAcceptedBcryptVerifier(`$2b$10$${"A".repeat(53).slice(0, 52)}!`), false, "a character outside [./A-Za-z0-9]");
  // Every member of the body's punctuation allowance, not just letters/digits.
  assert.equal(bcrypt.isAcceptedBcryptVerifier(`$2b$10$${".".repeat(53)}`), true);
  assert.equal(bcrypt.isAcceptedBcryptVerifier(`$2b$10$${"/".repeat(53)}`), true);
});

test("rejects non-string and malformed input without throwing", () => {
  for (const value of [undefined, null, 12345, {}, [], true, ""]) {
    assert.equal(bcrypt.isAcceptedBcryptVerifier(value), false, String(value));
  }
  assert.equal(bcrypt.isAcceptedBcryptVerifier("not-a-bcrypt-verifier-at-all"), false);
});
