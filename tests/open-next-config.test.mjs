/*
  What makes the static-assets cache safe is a fact about the app, not about
  this file: nothing anywhere sets `export const revalidate`, so there is no
  route this read-only, populated-once-at-build cache would ever need to
  refresh. That fact is silent — a future ISR page would not fail a build, it
  would just never revalidate, and the first anyone would hear of it is a
  learner looking at stale content. So this checks the premise directly
  instead of trusting the comment in open-next.config.ts that relies on it.

  The rest of this file checks the other half: that open-next.config.ts still
  asks for the static-assets cache and cache interception, rather than quietly
  drifting back to the default (which prerenders 52 routes at build time and
  then never reads any of them — see that file's own comment for the reasoning).
*/
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();

const { default: cloudflareConfig } = await import("../open-next.config.ts");
const { default: staticAssetsIncrementalCache, NAME: STATIC_ASSETS_CACHE_NAME } = await import(
  "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache"
);

test("cache interception is turned on", () => {
  assert.equal(cloudflareConfig.dangerous?.enableCacheInterception, true);
});

/*
  `incrementalCache` is stored as a `() => value` thunk (see
  `resolveIncrementalCache` in @opennextjs/cloudflare's config.js): passing
  anything other than a string or a function always gets wrapped that way.
  Calling it is what proves the value inside is actually the static-assets
  override and not, say, "dummy" or some other cache swapped in by mistake.
*/
for (const target of ["default", "middleware"]) {
  test(`${target}.override.incrementalCache resolves to the static-assets cache`, () => {
    const resolved = cloudflareConfig[target]?.override?.incrementalCache;
    assert.equal(typeof resolved, "function");
    assert.equal(resolved(), staticAssetsIncrementalCache);
    assert.equal(resolved().name, STATIC_ASSETS_CACHE_NAME);
  });
}

function walk(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

test("no route under app/ declares `export const revalidate`", () => {
  const offenders = walk("app")
    .filter((path) => /\.tsx?$/.test(path))
    .filter((path) => /^export const revalidate\b/m.test(readFileSync(join(root, path), "utf8")));

  assert.deepEqual(
    offenders,
    [],
    "a route declaring `export const revalidate` would silently never refresh: " +
      "the incremental cache here is populated once at build time and is read-only.",
  );
});

test("cf:build populates the static assets cache without opening a wrangler session", () => {
  // The CLI's populateCache needs a platform proxy, and therefore a Cloudflare
  // token, which the CI build step does not have. The copy is all we need.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.match(pkg.scripts["cf:build"], /node scripts\/populate-static-cache\.mjs$/);
  assert.doesNotMatch(pkg.scripts["cf:build"], /populateCache/);
  const script = readFileSync(join(root, "scripts", "populate-static-cache.mjs"), "utf8");
  assert.match(script, /cpSync\(SOURCE, DESTINATION, \{ recursive: true \}\)/);
  assert.match(script, /"cdn-cgi", "_next_cache"/);
});
