/*
  The same instant, spelled two ways, is not a drift.

  Found against real production data: the entitlement-parity endpoint
  compared `expiresAt` with a raw `===`, and Supabase's timestamptz text
  (`2027-08-11T16:22:20+00:00`) never equals D1's nine-digit canonical clock
  (`2027-08-11T16:22:20.000000000Z`) as strings, even when they name the exact
  same moment. Every account with a live subscription reported as drifted for
  its punctuation — the same shape of fault `parityClock` exists to fix in the
  migration fingerprints, one function over.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const root = process.cwd();
const { sameExpiry } = await import(
  pathToFileURL(join(root, "lib", "billing", "entitlements.ts")).href
);

test("the real production case: same instant, Postgres offset vs D1 nine-digit UTC", () => {
  assert.equal(
    sameExpiry("2027-08-11T16:22:20+00:00", "2027-08-11T16:22:20.000000000Z"),
    true,
  );
});

test("both null is equal, exactly one null is not", () => {
  assert.equal(sameExpiry(null, null), true);
  assert.equal(sameExpiry("2027-08-11T16:22:20+00:00", null), false);
  assert.equal(sameExpiry(null, "2027-08-11T16:22:20.000000000Z"), false);
});

test("a real difference in the instant is still caught", () => {
  assert.equal(
    sameExpiry("2027-08-11T16:22:20+00:00", "2027-08-11T16:22:21.000000000Z"),
    false,
  );
  assert.equal(
    sameExpiry("2027-08-11T16:22:20+00:00", "2028-08-11T16:22:20.000000000Z"),
    false,
  );
});

test("a non-UTC offset still resolves to the same instant", () => {
  assert.equal(
    sameExpiry("2027-08-11T08:22:20-08:00", "2027-08-11T16:22:20.000000000Z"),
    true,
  );
});

test("sub-second precision still distinguishes real drift", () => {
  assert.equal(
    sameExpiry("2027-08-11T16:22:20.500+00:00", "2027-08-11T16:22:20.000000000Z"),
    false,
  );
});

test("an unparseable value is reported as a difference, not waved through", () => {
  assert.equal(sameExpiry("not a timestamp", "2027-08-11T16:22:20.000000000Z"), false);
  assert.equal(sameExpiry("not a timestamp", "not a timestamp"), true);
});

test("fieldsEqual routes expiresAt through sameExpiry, not a bare ===", () => {
  const source = readFileSync(
    join(root, "app", "api", "admin", "cloudflare", "entitlement-parity", "route.ts"),
    "utf8",
  );
  const start = source.indexOf("function fieldsEqual(");
  const body = source.slice(start, source.indexOf("\n}", start));
  assert.match(body, /sameExpiry\(a\.expiresAt, b\.expiresAt\)/);
  assert.doesNotMatch(body, /a\.expiresAt === b\.expiresAt/);
  assert.match(source, /import \{ resolveEntitlementForParity, sameExpiry,/);
});
