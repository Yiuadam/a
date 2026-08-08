/*
  The sign-in flow cannot be exercised end to end from here: nothing in this
  environment can reach Supabase or an identity provider, and no credentials
  exist to try. What *can* be pinned is the pure logic — reading the fragment
  Supabase leaves behind, and deciding when a token has expired — and that is
  the part where a mistake is silent. A misparsed expiry does not throw; it
  signs someone out mid-test, or keeps sending a dead token and blames the
  server.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const { sessionFromFragment, errorFromFragment, isExpired } = await import(
  pathToFileURL(join(process.cwd(), "lib", "account.ts")).href
);

const NOW = 1_700_000_000_000;

test("reads an access token out of the callback fragment", () => {
  const s = sessionFromFragment(
    "#access_token=abc123&refresh_token=r-9&expires_in=3600&token_type=bearer",
    NOW,
  );
  assert.equal(s.accessToken, "abc123");
  assert.equal(s.refreshToken, "r-9");
  assert.equal(s.expiresAt, NOW + 3_600_000);
});

test("works whether or not the fragment keeps its leading hash", () => {
  const withHash = sessionFromFragment("#access_token=t", NOW);
  const without = sessionFromFragment("access_token=t", NOW);
  assert.equal(withHash.accessToken, "t");
  assert.equal(without.accessToken, "t");
});

test("a fragment with no access token is not a session", () => {
  assert.equal(sessionFromFragment("", NOW), null);
  assert.equal(sessionFromFragment("#", NOW), null);
  assert.equal(sessionFromFragment("#token_type=bearer", NOW), null);
});

test("a missing or nonsense expires_in leaves the expiry unknown, not zero", () => {
  // The failure this guards against: Number("") is 0, and an expiry of
  // "now + 0" would mark a perfectly good token as already expired, so the
  // app would refresh on every single request.
  assert.equal(sessionFromFragment("#access_token=t", NOW).expiresAt, null);
  assert.equal(sessionFromFragment("#access_token=t&expires_in=", NOW).expiresAt, null);
  assert.equal(sessionFromFragment("#access_token=t&expires_in=soon", NOW).expiresAt, null);
  assert.equal(sessionFromFragment("#access_token=t&expires_in=-5", NOW).expiresAt, null);
});

test("a token with an unknown expiry is not treated as expired", () => {
  assert.equal(isExpired({ accessToken: "t", refreshToken: null, expiresAt: null }, NOW), false);
});

test("expiry allows a minute of slack so a token cannot die in flight", () => {
  const almost = { accessToken: "t", refreshToken: null, expiresAt: NOW + 30_000 };
  const comfortable = { accessToken: "t", refreshToken: null, expiresAt: NOW + 120_000 };
  assert.equal(isExpired(almost, NOW), true);
  assert.equal(isExpired(comfortable, NOW), false);
});

test("no session at all counts as expired", () => {
  assert.equal(isExpired(null, NOW), true);
});

test("surfaces the provider's error description", () => {
  const message = errorFromFragment("#error=access_denied&error_description=You%20said%20no");
  assert.equal(message, "You said no");
});

test("falls back to the error code when there is no description", () => {
  assert.equal(errorFromFragment("#error=server_error"), "server_error");
});

test("a fragment carrying no error reports none", () => {
  assert.equal(errorFromFragment("#access_token=t"), null);
  assert.equal(errorFromFragment(""), null);
});

test("error text arriving from the URL bar cannot smuggle markup", () => {
  // This string is rendered into the page, and it comes from a part of the URL
  // anyone can write.
  const message = errorFromFragment("#error_description=%3Cimg%20src=x%20onerror=alert(1)%3E");
  assert.ok(!message.includes("<"));
  assert.ok(!message.includes(">"));
});

test("over-long error text is cut rather than rendered whole", () => {
  const message = errorFromFragment(`#error_description=${"a".repeat(500)}`);
  assert.ok(message.length <= 200);
});
