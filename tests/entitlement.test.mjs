/*
  The access token is the only thing standing between a stranger and the Claude
  bill. It is also the kind of code that looks right while being wrong — a
  signature checked over the wrong bytes, an expiry compared the wrong way
  round — and none of that is visible by reading it. These pin the properties
  the paywall actually depends on.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

process.env.BILLING_TOKEN_SECRET = "test-secret-not-used-anywhere-real";

register("../scripts/ts-resolve.mjs", import.meta.url);

const {
  REFRESH_GRACE_SECONDS,
  TTL_SECONDS,
  mintAccessToken,
  mintSeatCode,
  readSeatCode,
  safeEqual,
  verifyAccessToken,
} = await import(pathToFileURL(join(process.cwd(), "lib", "entitlement.ts")).href);

/** Run `fn` as if the clock had jumped forward by `seconds`. */
function atOffset(seconds, fn) {
  const real = Date.now;
  Date.now = () => real() + seconds * 1000;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

test("a freshly minted token verifies and carries its reference back", () => {
  const { claims, failure } = verifyAccessToken(mintAccessToken("sub", "cus_123"));
  assert.equal(failure, undefined);
  assert.equal(claims.k, "sub");
  assert.equal(claims.ref, "cus_123");
});

test("editing the payload invalidates the token", () => {
  const token = mintAccessToken("sub", "cus_123");
  const [payload, mac] = token.split(".");
  const forged = Buffer.from(
    JSON.stringify({ v: 1, k: "sub", ref: "cus_someone_else", e: 2 ** 40 }),
    "utf8",
  ).toString("base64url");

  assert.equal(verifyAccessToken(`${forged}.${mac}`).failure, "invalid");
  // And the original still works, so the failure above is the edit and not the
  // test having mangled the format.
  assert.ok(verifyAccessToken(`${payload}.${mac}`).claims);
});

test("a token signed with another secret is rejected", () => {
  const token = mintAccessToken("sub", "cus_123");
  const real = process.env.BILLING_TOKEN_SECRET;
  process.env.BILLING_TOKEN_SECRET = "a-different-secret";
  try {
    assert.equal(verifyAccessToken(token).failure, "invalid");
  } finally {
    process.env.BILLING_TOKEN_SECRET = real;
  }
});

test("a token expires, and refresh may still read it", () => {
  const token = mintAccessToken("sub", "cus_123");

  atOffset(TTL_SECONDS + 60, () => {
    assert.equal(verifyAccessToken(token).failure, "expired");
    // The refresh path trusts the signature but not the subscription, so it
    // must still be able to read who this was.
    assert.equal(verifyAccessToken(token, true).claims.ref, "cus_123");
  });
});

test("an abandoned token stops being refreshable", () => {
  const token = mintAccessToken("sub", "cus_123");

  atOffset(TTL_SECONDS + REFRESH_GRACE_SECONDS + 60, () => {
    assert.equal(verifyAccessToken(token, true).failure, "stale");
  });
});

test("a seat code cannot be presented as an access token", () => {
  // Both are signed with the same secret, so only the domain separation in the
  // HMAC stops a school code being replayed as a subscription.
  const code = mintSeatCode("in_123", 1);
  assert.equal(verifyAccessToken(code).failure, "invalid");
  assert.equal(verifyAccessToken(code.slice(3)).failure, "invalid");
});

test("a seat code round-trips, and a tampered one does not", () => {
  const code = mintSeatCode("in_123", 7);
  const seat = readSeatCode(code);
  assert.equal(seat.inv, "in_123");
  assert.equal(seat.n, 7);

  assert.equal(readSeatCode(`${code}x`), null);
  assert.equal(readSeatCode("BU-nonsense"), null);
  assert.equal(readSeatCode(""), null);
  // Whitespace from a copy-paste is the user's most likely mistake, not an attack.
  assert.equal(readSeatCode(`  ${code}\n`).inv, "in_123");
});

test("each seat of an invoice gets its own code", () => {
  const first = mintSeatCode("in_123", 1);
  const second = mintSeatCode("in_123", 2);
  assert.notEqual(first, second);
  assert.equal(readSeatCode(second).n, 2);
});

test("the constant-time compare still answers the question correctly", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "ab"), false);
  assert.equal(safeEqual("", ""), true);
});
