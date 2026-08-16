/*
  Nothing goes on the profile request that the profile response does not need.

  /api/account/profile is the request a signed-in page waits for — every route
  is prerendered and fast, and then the browser asks this one question before
  the app is usable. Two things had accumulated on it that its own answer never
  used:

  The Cloudflare mirror, awaited inside getLearnerProfile. Fourteen D1
  statements, six of them the same deletion-tombstone SELECT, and the function
  returned the Supabase profile whether the mirror worked or not.

  The organisation username readiness check, a three-table join awaited into
  the response body. Every consumer of that field is a type declaration and a
  default value; the only thing that read it was a repair in the same file,
  which can ask the question itself after the response has gone.

  Both now run in after(). This test is about *where* they run, because moving
  either back is a one-line change that no other test would notice and no
  reviewer would see the cost of.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/* Comments quote the old code, so assertions must not read them. */
const code = (...p) =>
  readFileSync(join(process.cwd(), ...p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

test("reading a profile does not wait for the Cloudflare mirror", () => {
  const router = code("lib", "cloudflare", "data-router.ts");

  const start = router.indexOf("export async function getLearnerProfile");
  assert.ok(start > -1, "getLearnerProfile is gone or renamed");
  const body = router.slice(start, router.indexOf("\n}", start));

  assert.doesNotMatch(
    body,
    /replicateLearnerProfileDurably/,
    "the mirror is back inside the read, so every signed-in page waits for it again",
  );

  /* It still has to happen — just not here. */
  assert.match(router, /export async function reconcileLearnerProfileReplica/);
  assert.match(router, /replicateLearnerProfileDurably/);
});

test("the route runs the mirror after the response", () => {
  const route = code("app", "api", "account", "profile", "route.ts");

  assert.match(
    route,
    /after\(\(\) => reconcileLearnerProfileReplica\(user, stored\)\)/,
    "the mirror is not deferred, or is deferred somewhere this test cannot see",
  );
});

test("the username readiness join is not awaited into the response", () => {
  const route = code("app", "api", "account", "profile", "route.ts");

  assert.doesNotMatch(
    route,
    /organizationUsernameReady:\s*await/,
    "a three-table join is back on the response path",
  );
  /*
    The key itself stays. An iOS bundle already in somebody's pocket may
    destructure it, and undefined is a different shape from null.
  */
  assert.match(route, /organizationUsernameReady:\s*null/);

  /* And the repair it used to trigger still runs, having asked for itself. */
  const start = route.indexOf("after(async () =>");
  assert.ok(start > -1, "the deferred repair block is gone");
  const deferred = route.slice(start, start + 700);
  assert.match(deferred, /learnerUsernameReplicaReady/);
  assert.match(deferred, /repairLearnerUsernameReplica/);
});
