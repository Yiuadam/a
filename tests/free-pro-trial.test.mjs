/*
  The free Pro trial.

  Three things are worth pinning, and they are the three that would fail
  silently. Who is offered it: a Pro subscriber or the owner must never be shown
  an offer of what they already have. What the poster says: the sentence about
  the trial being able to end is the reason ending it later is fair, so its
  absence is a defect rather than a copy change. And that nothing in this
  feature writes a migration — the constraint it depends on is applied by hand.
*/
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const root = process.cwd();
const promo = await import(pathToFileURL(join(root, "lib", "billing", "promo.ts")).href);
const tiers = await import(pathToFileURL(join(root, "lib", "billing", "tiers.ts")).href);

const poster = readFileSync(join(root, "components", "billing", "FreeProPoster.tsx"), "utf8");
const route = readFileSync(join(root, "app", "api", "billing", "promo", "route.ts"), "utf8");
const supabase = readFileSync(join(root, "lib", "auth", "supabase.ts"), "utf8");

test("only tiers below Pro are offered the trial", () => {
  for (const tier of Object.keys(tiers.TIERS)) {
    const covered = promo.alreadyCovered(tier);
    assert.equal(covered, tier === "pro" || tier === "admin", `wrong answer for ${tier}`);
  }
});

test("the poster says the trial can end and that nobody is charged", () => {
  assert.match(poster, /may be cancelled at any time in the future/);
  assert.match(poster, /back to the free plan/);
  assert.match(poster, /never be charged without choosing to subscribe/);
});

test("the poster does not manufacture urgency", () => {
  for (const pattern of [/\bhurry\b/i, /\blimited time\b/i, /\bends (?:in|soon)\b/i, /\bonly \d+ /i]) {
    assert.doesNotMatch(poster, pattern, `poster uses pressure: ${pattern}`);
  }
});

test("the grant is a Pro subscription row, written only by the server", () => {
  assert.match(supabase, /provider: PROMO_PROVIDER/);
  assert.match(supabase, /tier: "pro"/);
  assert.match(supabase, /status: "active"/);
  // The tier is fixed in server code. Nothing the client sends chooses it.
  assert.doesNotMatch(route, /req\.json\(\)/);
});

test("accepting degrades honestly when the provider constraint is still narrow", () => {
  assert.match(supabase, /export async function promoProviderAllowed/);
  assert.match(route, /notOpen/);
  // 503 with a sentence, never an unhandled throw turning into a 500.
  assert.match(route, /safeJsonError\(PROMO_MESSAGES\.notOpen, 503\)/);
});

test("the trial ships no migration of its own", () => {
  const migrations = readdirSync(join(root, "supabase", "migrations"));
  const named = migrations.filter((file) => /promo/i.test(file));
  assert.deepEqual(named, [], "the widening ALTER is run by hand, not shipped as a migration");
});
