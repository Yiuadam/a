/*
  lib/billing/region.ts: the visitor's currency, resolved from Cloudflare's
  CF-IPCountry header while the page still renders — see that file's header
  for the London-reads-HK$4.90 bug this replaced. tests/pricing-currency
  .test.mjs already pins the *wiring* (the page awaits this, the guard runs
  before headers() is called) as source-text assertions, which is exactly
  the kind of check a mutant sails straight through — this file drives the
  function itself.

  next/headers has no fixture the way a Cloudflare binding does, so
  tests/fake-next-headers-resolve.mjs redirects the bare specifier to a tiny
  fake controlled through globalThis.__FAKE_NEXT_HEADERS__.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);
register("./cutover-write-barrier-resolve.mjs", import.meta.url);
register("./fake-next-headers-resolve.mjs", import.meta.url);

const region = await import(
  pathToFileURL(join(process.cwd(), "lib", "billing", "region.ts")).href
);
const { visitorCurrency } = region;

/** A fake `next/headers` Headers-like object over a plain lookup. */
function fakeHeaders(values) {
  const lower = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => lower.get(name.toLowerCase()) ?? null };
}

function withMobileBuild(value, fn) {
  const saved = process.env.MOBILE_BUILD;
  if (value === undefined) delete process.env.MOBILE_BUILD;
  else process.env.MOBILE_BUILD = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (saved === undefined) delete process.env.MOBILE_BUILD;
      else process.env.MOBILE_BUILD = saved;
    });
}

function withFakeHeaders(values, fn) {
  globalThis.__FAKE_NEXT_HEADERS__ = () => fakeHeaders(values);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      delete globalThis.__FAKE_NEXT_HEADERS__;
    });
}

test("visitorCurrency refuses to run outside the server, naming this module", async () => {
  globalThis.window = {};
  try {
    await assert.rejects(
      () => visitorCurrency(),
      (error) => error instanceof Error && error.message.includes("lib/billing/region.ts"),
    );
  } finally {
    delete globalThis.window;
  }
});

test("the mobile static export returns null without ever calling headers()", () =>
  withMobileBuild("1", () =>
    withFakeHeaders({ "cf-ipcountry": "US" }, async () => {
      // A build that genuinely called headers() during a static export would
      // fail outright (see the file's own header comment); standing in for
      // that here, the fake throws if it is ever reached at all.
      globalThis.__FAKE_NEXT_HEADERS__ = () => {
        throw new Error("headers() must not be called during a static export");
      };
      assert.equal(await visitorCurrency(), null);
    })));

test("outside the static export, a resolved country reaches currencyForCountry", () =>
  withMobileBuild(undefined, () =>
    withFakeHeaders({ "cf-ipcountry": "GB" }, async () => {
      assert.equal(await visitorCurrency(), "gbp");
    })));

test("a request with no CF-IPCountry at all (local dev) resolves to null, not the USD fallback", () =>
  withMobileBuild(undefined, () =>
    withFakeHeaders({}, async () => {
      assert.equal(await visitorCurrency(), null);
    })));

test("an unrecognised or Tor exit country still resolves to the USD fallback, not null", () =>
  withMobileBuild(undefined, () =>
    withFakeHeaders({ "cf-ipcountry": "XX" }, async () => {
      assert.equal(await visitorCurrency(), "usd");
    })));

test("MOBILE_BUILD is read as the literal string \"1\", not any other truthy value", () =>
  withMobileBuild("true", () =>
    withFakeHeaders({ "cf-ipcountry": "GB" }, async () => {
      // Only the exact string "1" means the static export; anything else
      // (including a value someone might mistake for a boolean) must still
      // read the request normally.
      assert.equal(await visitorCurrency(), "gbp");
    })));
