/*
  The password route's ten-wrong-attempts-in-fifteen-minutes limiter used to
  answer with MESSAGES.rateLimited, which is written for the AI tutor's
  weekly quota — "this week's allowance", "your billing page shows when" —
  and means nothing to someone who has just mistyped a password. This drives
  the real route handler through that limit end to end and checks the
  eleventh attempt's actual response, rather than guessing its shape from the
  source text.

  lib/auth/errors.ts and app/api/auth/password/route.ts both import
  NextResponse from "next/server", a subpath this Next install has no
  `exports` entry for — plain ESM resolution refuses it outright, which is
  why tests/native-email-auth.test.mjs reads this same route file as text
  instead of importing it. tests/cutover-write-barrier-resolve.mjs already
  solves that (registered by tests/billing-closed.test.mjs for the same
  reason), by redirecting the bare specifier straight at next/server's own
  file, so it is reused here rather than re-solved.

  Nothing here reaches a real Supabase project: SUPABASE_URL points at a
  closed local port, so every attempt this spends resolves in milliseconds as
  an ordinary failed sign-in — signInWithPassword swallows the connection
  failure and returns null — never as a real network round trip.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);
register("./cutover-write-barrier-resolve.mjs", import.meta.url);

process.env.ACCOUNTS_ENABLED = "1";
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
delete process.env.CLOUDFLARE_NATIVE_AUTH;

const root = process.cwd();
const { MESSAGES } = await import(pathToFileURL(join(root, "lib", "auth", "errors.ts")).href);
const route = await import(pathToFileURL(join(root, "app", "api", "auth", "password", "route.ts")).href);
const guardSource = readFileSync(join(root, "lib", "usage", "guard.ts"), "utf8");
const routeSource = readFileSync(join(root, "app", "api", "auth", "password", "route.ts"), "utf8");

/** One sign-in attempt against the real route, from a chosen IP so each test picks its own rate-limit bucket. */
function attemptSignIn(ip) {
  const req = new Request("https://bandup.life/api/auth/password", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ identifier: "learner@example.com", password: "wrong-password-guess" }),
  });
  return route.POST(req);
}

test("MESSAGES carries a sign-in-shaped rate-limit message, distinct from the AI tutor's quota one", () => {
  assert.equal(
    MESSAGES.tooManySignInAttempts,
    "Too many attempts. Please wait 15 minutes, or email yourself a sign-in link.",
  );
  // Says how long to wait and names a door that needs no remembered password,
  // and nothing about an allowance or a billing page — which is what made
  // the borrowed AI-tutor message wrong for this route in the first place.
  assert.doesNotMatch(MESSAGES.tooManySignInAttempts, /allowance|billing/i);
});

test("MESSAGES.rateLimited is untouched — the AI tutor's quota routes still depend on its exact wording", () => {
  assert.equal(
    MESSAGES.rateLimited,
    "You've used this week's allowance for this. It refills a week after each request, so some of it comes back tomorrow — your billing page shows when.",
  );
  // Out of scope for this change, but this is why it had to stay rather than
  // being reworded or removed once the password route stopped using it.
  assert.match(guardSource, /MESSAGES\.rateLimited/);
});

test("ten wrong passwords from one address are ordinary failures; the eleventh is the sign-in rate limit", async () => {
  const ip = "203.0.113.10";
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const res = await attemptSignIn(ip);
    assert.equal(res.status, 401, `attempt ${attempt} should not yet be rate-limited`);
  }

  const eleventh = await attemptSignIn(ip);
  assert.equal(eleventh.status, 429);
  const body = await eleventh.json();
  assert.equal(body.error, MESSAGES.tooManySignInAttempts);
  assert.notEqual(body.error, MESSAGES.rateLimited, "the AI tutor's quota message must not leak into a sign-in response");
});

test("the limit is keyed per address, so it does not spill onto a different caller", async () => {
  // A fresh IP, never attempted before in this run: still an ordinary wrong
  // password, not a rate limit — the ten attempts above belonged to someone
  // else's address.
  const res = await attemptSignIn("203.0.113.11");
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.notEqual(body.error, MESSAGES.tooManySignInAttempts);
});

test("MESSAGES.rateLimited is not reachable anywhere in the password route's source", () => {
  assert.doesNotMatch(routeSource, /MESSAGES\.rateLimited/);
});
