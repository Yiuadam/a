/*
  lib/auth/native-session.ts signs and verifies the HMAC-based access token
  that stands in for a BandUp session once the Cloudflare-native path is
  live. This file targets the mutation survivors scripts/mutation/survivors.mjs
  lib/auth native-session.ts reported, by importing the real module and
  asserting on what it returns, throws, or produces byte-for-byte.

  A few reported survivors are not tested here because they are genuinely
  equivalent mutants -- no input the exported functions can receive makes
  them behave differently from the real code. Each is called out at its test
  with the reasoning, rather than silently skipped:

    - line 40 `/=+$/g` -> `/=+/g` (dropping the `$` anchor): the string this
      runs on is always btoa()'s own output, which by construction can only
      ever place "=" padding at the very end -- never mid-string -- so an
      anchored-at-end match and an anchored-nowhere match remove the exact
      same substring for every possible byte input.
    - line 47 `"=" -> ""` and `value.length % 4 -> value.length * 4`: verified
      empirically below (see the "Node's atob() is forgiving..." test) that
      Node's atob() already tolerates a missing 1- or 2-character pad, and a
      would-be remainder of 1 is unrecoverably invalid either way -- so
      whatever padding this line computes and appends never changes atob's
      output.
    - line 66 (five mutants weakening jsonPart's `parsed && typeof === "object"
      && !Array.isArray` guard): every caller of jsonPart re-checks specific
      named properties (iss/aud, alg/typ, isPayload's own field list)
      immediately afterwards. JSON.parse can never produce an array or a
      primitive that also carries those named string properties, and a falsy
      "parsed" (null, 0, "") is indistinguishable from jsonPart's own `null`
      fallback at the `!header`/`!payload` checks one level up. So every kind
      of value this guard exists to reject is independently rejected by the
      code that reads jsonPart's result, whether or not the guard runs.
    - line 79 `false -> true` (the `extractable` flag passed to
      crypto.subtle.importKey): the key never leaves signingKey() through
      exportKey/JWK -- it is used immediately for sign/verify and discarded --
      so whether the underlying key *could* be exported changes nothing this
      module or its callers can observe.
    - line 106 `value.exp > value.iat` (in isPayload) -> `true` / `>=`:
      verifyNativeAccessToken's own later check,
      `payload.exp * 1000 <= now || payload.iat * 1000 > now`, only ever
      passes for a chosen `now` when `iat * 1000 <= now < exp * 1000` --
      which already requires `iat < exp`. So whenever that later check would
      let a token through, isPayload's separate exp>iat guard was always
      going to agree, for any `now` a caller could supply; it can never be
      the deciding check.
    - line 138 `payload?.aud -> payload.aud` (dropping the second `?.`): the
      `&&` before it short-circuits without evaluating the right operand at
      all unless `payload?.iss === ISSUER` was already true, which is only
      possible when `payload` is a real, non-nullish object. So by the time
      `.aud` would be read, optional chaining or not, `payload` can never be
      null/undefined there.
*/
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { withBrowserWindow } from "./lib-auth-mutation-helpers.mjs";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
register("./alias-resolve.mjs", import.meta.url);

const nativeSession = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "native-session.ts")).href
);

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "learner@example.test" };
const SID = "session-11111111-1111-4111-8111-111111111111";
const SECRET = "a dedicated native-session mutation test secret";

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}
function jsonPartRaw(value) {
  return base64Url(Buffer.from(JSON.stringify(value)));
}

test("Node's atob() is forgiving of a missing 1- or 2-character pad (justifies the line-47 equivalence above)", () => {
  // These are exactly the remainders lib/auth/native-session.ts's own base64url
  // strings can have (never a remainder of 1 -- see below).
  assert.equal(atob("QUI="), atob("QUI"), "remainder-2 (one byte short of a group): padding is optional");
  assert.equal(atob("QUJD".slice(0, 3) + "="), atob("QUJD".slice(0, 3)), "remainder-3: padding is optional");
  assert.throws(() => atob("Q"), "remainder-1 has no valid decoding, padded or not");
  assert.throws(() => atob(`Q${"=".repeat(3)}`), "...including with the original code's own padding formula applied to it");
});

test("assertServerOnly guards every exported entry point, naming this exact module", async () => {
  await withBrowserWindow(async () => {
    await assert.rejects(
      () => nativeSession.createNativeAccessToken(USER, SID, SECRET),
      /lib\/auth\/native-session\.ts is server-only/,
    );
    await assert.rejects(
      () => nativeSession.verifyNativeAccessToken("a.b.c", SECRET),
      /lib\/auth\/native-session\.ts is server-only/,
    );
  });
});

test("randomSessionToken never carries base64 padding, even where padding would otherwise be needed", () => {
  // 1 byte base64-encodes to "XX==" (2 padding characters) before stripping.
  // The line-47 "drop the +" mutant only ever strips the LAST one in a single
  // non-overlapping pass, leaving one "=" behind -- this is the case that
  // catches it.
  const oneByte = nativeSession.randomSessionToken(1);
  assert.equal(oneByte.length, 2, oneByte);
  assert.match(oneByte, /^[A-Za-z0-9_-]{2}$/);

  // 2 bytes base64-encodes to "XXX=" (1 padding character) before stripping.
  const twoBytes = nativeSession.randomSessionToken(2);
  assert.equal(twoBytes.length, 3, twoBytes);
  assert.match(twoBytes, /^[A-Za-z0-9_-]{3}$/);

  // The ordinary 48-byte token used for real sessions: no trailing "=", "+" or "/".
  const ordinary = nativeSession.randomSessionToken();
  assert.equal(ordinary.length, 64);
  assert.match(ordinary, /^[A-Za-z0-9_-]{64}$/);
  assert.notEqual(nativeSession.randomSessionToken(), nativeSession.randomSessionToken());
});

/*
  A random filler string gives the JSON payload's bytes enough bit diversity
  to land on the 6-bit values base64 reserves for "+"/"/" somewhere in the
  stream. A repeated filler character does not: repeating one ASCII byte
  produces a periodic bit pattern whose 6-bit windows cycle through only a
  handful of fixed values, and empirically (tried below in CI-independent
  scratch work) never land on 62/63 for any length of "x" -- random content
  finds one within a handful of tries essentially always.
*/
function randomPad(length) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 !@#$%^&*(){}[]<>,.?|";
  let out = "";
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function standardBase64WithPlusOrSlash(value) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const candidate = jsonPartRaw({ ...value, pad: randomPad(24) }).replace(/-/g, "+").replace(/_/g, "/");
    if (/[+/]/.test(candidate)) return candidate;
  }
  return null;
}

test("looksLikeNativeAccessToken accepts a payload part valid base64 but invalid base64url, if and only if it decodes to the right claims", () => {
  // Constructs a payload segment containing a literal "+" or "/" -- outside
  // decodeBase64Url's own [A-Za-z0-9_-] gate, but perfectly legal *standard*
  // base64 once the "-"/"_" substitution (a no-op here) and atob() see it.
  // If line 44's gate is skipped (as the "-> false" and both anchor-dropped
  // regex mutants do), this decodes cleanly to a real {iss, aud} match; under
  // real code the gate rejects it before atob ever runs.
  const raw = standardBase64WithPlusOrSlash({ iss: "bandup.cloudflare", aud: "bandup-api" });
  assert.ok(raw, "expected some random filler to produce a standard-base64 '+' or '/' within 300 tries");
  assert.match(raw, /[+/]/, "sanity: the crafted payload segment is not itself base64url-safe");

  assert.equal(
    nativeSession.looksLikeNativeAccessToken(`header.${raw}.sig`),
    false,
    "real code: decodeBase64Url's [A-Za-z0-9_-] gate must reject a segment containing '+' or '/' before atob ever runs",
  );
});

test("verifyNativeAccessToken rejects a header or payload segment with a '+' or '/' the same way", async () => {
  const { accessToken } = await nativeSession.createNativeAccessToken(USER, SID, SECRET, Date.UTC(2026, 0, 1));
  const [header, , signature] = accessToken.split(".");
  const plusPayload = standardBase64WithPlusOrSlash({
    iss: "bandup.cloudflare", aud: "bandup-api", sub: USER.id, email: USER.email,
    sid: SID, iat: 1, exp: 999999999,
  });
  assert.ok(plusPayload);
  assert.equal(await nativeSession.verifyNativeAccessToken(`${header}.${plusPayload}.${signature}`, SECRET), null);
});

test("createNativeAccessToken's expiresAt is issuedAt-plus-one-hour in *milliseconds*, not divided", async () => {
  const now = Date.UTC(2026, 5, 1, 12, 0, 0);
  const created = await nativeSession.createNativeAccessToken(USER, SID, SECRET, now);
  const expectedIssuedAtSeconds = Math.floor(now / 1000);
  const expectedExpirySeconds = expectedIssuedAtSeconds + nativeSession.ACCESS_TOKEN_SECONDS;
  assert.equal(created.expiresAt, expectedExpirySeconds * 1000);
  // A `/ 1000` mutant would produce a tiny fraction instead -- pin the order
  // of magnitude too, so a change that happened to cancel out numerically
  // could not slip past the exact-equality check above by coincidence.
  assert.ok(created.expiresAt > now, "expiresAt must be a real future millisecond timestamp");
});

test("looksLikeNativeAccessToken and verifyNativeAccessToken both require exactly three dot-separated parts", async () => {
  const now = Date.UTC(2026, 0, 1);
  const { accessToken } = await nativeSession.createNativeAccessToken(USER, SID, SECRET, now);
  const [h, p, s] = accessToken.split(".");
  // Same `now` used to sign the token, always passed explicitly below: the
  // default (real wall-clock Date.now()) would reject the four-part case for
  // the unrelated reason that a fixed 2026 token has since expired, hiding
  // the parts.length check this test exists to pin down. In particular the
  // trailing ".extra" case is the one that distinguishes a
  // `parts.length !== 3` bypass from every other check: destructuring
  // `[headerPart, payloadPart, signaturePart]` off a four-element array
  // silently keeps the first three -- a genuinely valid header/payload/
  // signature -- and drops "extra" on the floor, so nothing downstream
  // would object to it either.
  const verifyNow = now + 1000;

  for (const malformed of [`${h}.${p}`, `${h}.${p}.${s}.extra`, "", "onepart"]) {
    assert.equal(nativeSession.looksLikeNativeAccessToken(malformed), false, malformed);
    assert.equal(await nativeSession.verifyNativeAccessToken(malformed, SECRET, verifyNow), null, malformed);
  }
  // Sanity: the real, unmangled three-part token is accepted by both.
  assert.equal(nativeSession.looksLikeNativeAccessToken(accessToken), true);
  assert.ok(await nativeSession.verifyNativeAccessToken(accessToken, SECRET, verifyNow));
});

test("verifyNativeAccessToken rejects an oversized token even when it is otherwise a legitimately signed one", async () => {
  // isPayload has no length cap on `email`, so a real, correctly signed token
  // can be pushed past 4096 characters purely by the email claim's length --
  // proving the >4096 guard is what rejects it, not a signature or shape
  // failure that a bypassed guard would also have hit.
  const now = Date.UTC(2026, 0, 1);
  const hugeEmail = `${"x".repeat(4200)}@example.test`;
  const oversized = await nativeSession.createNativeAccessToken({ id: USER.id, email: hugeEmail }, SID, SECRET, now);
  assert.ok(oversized.accessToken.length > 4096, `test setup: expected >4096, got ${oversized.accessToken.length}`);
  assert.equal(await nativeSession.verifyNativeAccessToken(oversized.accessToken, SECRET, now + 1000), null);
});

/**
 * Token length grows with the (otherwise-unused) email claim's length, but
 * not one-for-one -- base64 quantises in groups of 3 source bytes, so length
 * is a non-decreasing step function of the padding rather than linear.
 * Binary-search the smallest padding whose token is at least `target`
 * characters, then scan a small neighbourhood for an exact match, rather
 * than guessing a fixed padding range that a future change to the payload
 * shape (or ACCESS_TOKEN_SECONDS's digit count) could throw off.
 */
async function tokenOfExactLength(target, now) {
  const lengthAt = async (extra) => {
    const email = `${"x".repeat(extra)}@example.test`;
    const created = await nativeSession.createNativeAccessToken({ id: USER.id, email }, SID, SECRET, now);
    return created.accessToken.length;
  };
  let lo = 0;
  let hi = 8192;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await lengthAt(mid)) >= target) hi = mid; else lo = mid + 1;
  }
  for (let extra = Math.max(0, lo - 3); extra <= lo + 3; extra += 1) {
    const email = `${"x".repeat(extra)}@example.test`;
    const created = await nativeSession.createNativeAccessToken({ id: USER.id, email }, SID, SECRET, now);
    if (created.accessToken.length === target) return created.accessToken;
  }
  return null;
}

test("verifyNativeAccessToken's 4096-character limit rejects only what is strictly over it", async () => {
  // Calibrates a real, correctly signed token to exactly 4096 characters --
  // a `>` -> `>=` mutant would reject this exact length, where real code must not.
  const now = Date.UTC(2026, 0, 1);
  const atLimit = await tokenOfExactLength(4096, now);
  assert.ok(atLimit, "expected some email padding to land the token at exactly 4096 characters");
  assert.equal(atLimit.length, 4096);
  const verified = await nativeSession.verifyNativeAccessToken(atLimit, SECRET, now + 1000);
  assert.ok(verified, "a token of exactly 4096 characters must still be accepted");
  assert.equal(verified.user.id, USER.id);
});
