/*
  Who the owner is, when it is named in an environment variable.

  The risk this guards is a comparison that is nearly right: an address typed
  into a login form and one pasted into a Cloudflare secret differ by case and
  by whitespace far more often than they differ by spelling. A near-miss here
  does not fail loudly — it silently denies the owner their own account.

  The other half is the one that matters more. `isAdminEmail` decides who is an
  admin, so anything it says yes to gets an unlimited allowance. Empty input,
  a stray comma, an unset variable — every one of those must be a no.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const load = async () =>
  import(`${pathToFileURL(join(process.cwd(), "lib", "auth", "env.ts")).href}?v=${Math.random()}`);

async function withEnv(value, fn) {
  const had = "ADMIN_EMAILS" in process.env;
  const prev = process.env.ADMIN_EMAILS;
  if (value === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = value;
  try {
    await fn(await load());
  } finally {
    if (had) process.env.ADMIN_EMAILS = prev;
    else delete process.env.ADMIN_EMAILS;
  }
}

test("the owner's address matches however it is typed", async () => {
  await withEnv("  Owner@Example.COM ", ({ isAdminEmail }) => {
    for (const typed of ["owner@example.com", "Owner@Example.com", " owner@example.com  ", "OWNER@EXAMPLE.COM"]) {
      assert.equal(isAdminEmail(typed), true, typed);
    }
  });
});

test("several owners, comma separated", async () => {
  await withEnv("a@x.com, b@y.com", ({ isAdminEmail }) => {
    assert.equal(isAdminEmail("a@x.com"), true);
    assert.equal(isAdminEmail("b@y.com"), true);
    assert.equal(isAdminEmail("c@z.com"), false);
  });
});

test("nobody is an admin when the variable is unset", async () => {
  await withEnv(undefined, ({ isAdminEmail, adminEmails }) => {
    assert.deepEqual(adminEmails(), []);
    assert.equal(isAdminEmail("anyone@example.com"), false);
  });
});

test("an empty or comma-only value grants nothing", async () => {
  for (const value of ["", "   ", ",", ",,,", " , , "]) {
    await withEnv(value, ({ isAdminEmail, adminEmails }) => {
      assert.deepEqual(adminEmails(), [], JSON.stringify(value));
      assert.equal(isAdminEmail(""), false);
      assert.equal(isAdminEmail("someone@example.com"), false, JSON.stringify(value));
    });
  }
});

test("a missing address is never an admin", async () => {
  await withEnv("owner@example.com", ({ isAdminEmail }) => {
    for (const value of [null, undefined, "", "   "]) {
      assert.equal(isAdminEmail(value), false, String(value));
    }
  });
});

test("a partial match is not a match", async () => {
  await withEnv("owner@example.com", ({ isAdminEmail }) => {
    for (const near of ["owner@example.co", "owner@example.com.evil.com", "xowner@example.com", "owner@example.como"]) {
      assert.equal(isAdminEmail(near), false, near);
    }
  });
});
