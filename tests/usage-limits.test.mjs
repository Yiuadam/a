/*
  lib/usage/limits.ts's plain exports: the two window lengths the meter
  checks every call against, and the jsonb shape check_and_record_usage reads.

  tests/usage-meter.test.mjs already proves the *meter* against a real
  Postgres, but it skips outright without a local instance, so it cannot be
  relied on to pin the two second-count constants themselves. Those are
  arithmetic literals a stray `/` for `*` would not fail any compile step —
  this file exists to catch exactly that.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const limits = await import(
  pathToFileURL(join(process.cwd(), "lib", "usage", "limits.ts")).href
);

test("the rolling windows are a week and thirty days, in seconds", () => {
  assert.equal(limits.USAGE_WINDOW_SECONDS, 7 * 24 * 60 * 60);
  assert.equal(limits.USAGE_WINDOW_SECONDS, 604_800);
  assert.equal(limits.MONTH_WINDOW_SECONDS, 30 * 24 * 60 * 60);
  assert.equal(limits.MONTH_WINDOW_SECONDS, 2_592_000);
});

test("limitsForDatabase carries both windows and every fixed fallback field", () => {
  const built = limits.limitsForDatabase();
  assert.equal(built.month_seconds, limits.MONTH_WINDOW_SECONDS);
  assert.equal(built.schema, limits.LIMITS_SCHEMA_VERSION);
  assert.equal(built.anonymous, limits.ANONYMOUS_DAILY_AI_CALLS);
  assert.equal(built.ip, limits.IP_DAILY_CEILING);
  assert.equal(built.free, 0);
  assert.equal(built.tracking, 0);
  assert.equal(built.ai, 0);
  assert.equal(built.admin, null);
  assert.ok(built.monthly.ai, "the per-tier monthly caps must be attached");
  assert.ok(built.daily.ai, "the per-tier weekly caps must be attached, still under the 'daily' key");
});

test("isAiRoute recognises exactly the costed routes", () => {
  for (const route of limits.AI_ROUTES) assert.equal(limits.isAiRoute(route), true);
  assert.equal(limits.isAiRoute("not-a-route"), false);
  assert.equal(limits.isAiRoute(""), false);
});
