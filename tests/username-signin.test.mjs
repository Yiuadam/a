/*
  Resolving what somebody typed into the identifier box.

  The form takes one field for two kinds of thing, so this function decides
  which. Three ways it could go wrong, and each has a test:

    A username that resolves when it should not. `emailForIdentifier` returning
      an address for an unknown name would hand an attacker a valid target for
      free; returning null makes it indistinguishable from a wrong password.

    A username that fails to resolve when it should. The owner locked out of
      their own app by a capital letter is the failure nobody would think to
      look for, because they would assume they had mistyped the password.

    An address treated as a username, or the reverse. The @ is the whole test,
      and it has to be applied to the raw input rather than to a lowercased
      copy that has already lost its shape.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const load = async () =>
  import(`${pathToFileURL(join(process.cwd(), "lib", "auth", "env.ts")).href}?v=${Math.random()}`);

async function withEnv({ emails, username }, fn) {
  const prev = { e: process.env.ADMIN_EMAILS, u: process.env.ADMIN_USERNAME };
  const had = { e: "ADMIN_EMAILS" in process.env, u: "ADMIN_USERNAME" in process.env };
  if (emails === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = emails;
  if (username === undefined) delete process.env.ADMIN_USERNAME;
  else process.env.ADMIN_USERNAME = username;
  try {
    await fn(await load());
  } finally {
    if (had.e) process.env.ADMIN_EMAILS = prev.e;
    else delete process.env.ADMIN_EMAILS;
    if (had.u) process.env.ADMIN_USERNAME = prev.u;
    else delete process.env.ADMIN_USERNAME;
  }
}

test("the owner's username resolves to the owner's address", async () => {
  await withEnv({ emails: "Owner@Example.com", username: "Adam" }, ({ emailForIdentifier }) => {
    for (const typed of ["Adam", "adam", " ADAM ", "aDaM"]) {
      assert.equal(emailForIdentifier(typed), "owner@example.com", typed);
    }
  });
});

test("any other username resolves to nothing at all", async () => {
  await withEnv({ emails: "owner@example.com", username: "adam" }, ({ emailForIdentifier }) => {
    for (const typed of ["admin", "root", "adam2", "ada", "", "   "]) {
      assert.equal(emailForIdentifier(typed), null, typed);
    }
  });
});

test("with no username configured, only addresses resolve", async () => {
  await withEnv({ emails: "owner@example.com", username: undefined }, ({ emailForIdentifier }) => {
    assert.equal(emailForIdentifier("adam"), null);
    assert.equal(emailForIdentifier("owner@example.com"), "owner@example.com");
  });
});

test("a username with no admin address behind it resolves to nothing", async () => {
  await withEnv({ emails: undefined, username: "adam" }, ({ emailForIdentifier }) => {
    assert.equal(emailForIdentifier("adam"), null);
  });
});

test("an address passes through, lower-cased and trimmed", async () => {
  await withEnv({ emails: "owner@example.com", username: "adam" }, ({ emailForIdentifier }) => {
    assert.equal(emailForIdentifier("  Learner@Example.COM "), "learner@example.com");
    /* Not the owner's address — resolving is not authorising. */
    assert.equal(emailForIdentifier("someone@else.test"), "someone@else.test");
  });
});

test("the username is matched, never the address list, for names with no @", async () => {
  await withEnv({ emails: "owner@example.com,second@example.com", username: "adam" }, ({
    emailForIdentifier,
  }) => {
    /* The first entry is the one a username maps to, deterministically. */
    assert.equal(emailForIdentifier("adam"), "owner@example.com");
    assert.equal(emailForIdentifier("owner"), null);
  });
});
