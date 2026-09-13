/*
  Which shelf a learner sees when the account lookup has genuinely failed,
  pinned against lib/entitlements/useSessions.ts's own realSessionTier()
  rather than only implied by reading the source.

  ---------------------------------------------------------------------------
  The bug this guards against

  realSessionTier's first branch — "unavailable" and accounts are enabled on
  this deployment maps to "anonymous" — used to be dead code. lib/billing/
  useTier.ts's catch handler reset the whole state to its INITIAL constant on
  every failure, and INITIAL.accountsEnabled is false, so `accountsEnabled`
  was false on every single failure regardless of whether this deployment
  actually has accounts. The branch's condition could never be true, and
  every failed lookup fell through to the next branch instead, answering
  "free" — the tier that unlocks every skill, unlimited — for a caller the
  server had simply failed to hear back from.

  useTier.ts now carries `accountsEnabled` forward from whatever it last knew
  instead of resetting it (see the WHY comment on its catch handler), which is
  what these tests exercise: not the network failure itself, but the mapping
  a failure lands on once that flag is telling the truth.

  ---------------------------------------------------------------------------
  Why "anonymous" is the safe answer for a real failure, and "free" is not

  Free is EVERYTHING, unlimited (lib/entitlements/sessions.ts) — the same
  shelf a genuine signed-in account gets. Handing that to somebody the server
  could not actually verify is the same mistake the file's header describes
  the old "pro" fallback making, just one rung down the ladder: writing and
  speaking would draw as open, and a visitor with no account at all would
  reach the server and be refused. Anonymous is the one tier with real limits
  left (lib/entitlements/sessions.ts), so it is the tier that costs nothing to
  guess wrong in either direction.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./next-navigation-stub.mjs", import.meta.url);
register("./alias-resolve.mjs", import.meta.url);

const { realSessionTier } = await import(
  pathToFileURL(join(process.cwd(), "lib", "entitlements", "useSessions.ts")).href
);

/** A minimal TierState-shaped fixture — only the fields realSessionTier reads. */
function account(overrides) {
  return { phase: "ready", accountsEnabled: true, signedIn: true, tier: null, ...overrides };
}

test("a genuine failure on a deployment that has accounts falls back to anonymous, not free", () => {
  assert.equal(
    realSessionTier(account({ phase: "unavailable", accountsEnabled: true, signedIn: true, tier: "ai" })),
    "anonymous",
    "this is the branch that used to be unreachable",
  );
});

test("a failure on a deployment with accounts switched off is still just Free — there is no tier to fail", () => {
  assert.equal(
    realSessionTier(account({ phase: "unavailable", accountsEnabled: false, signedIn: false, tier: null })),
    "free",
  );
});

test("still loading stays optimistic regardless of what accountsEnabled will turn out to be", () => {
  for (const accountsEnabled of [true, false]) {
    assert.equal(
      realSessionTier(account({ phase: "loading", accountsEnabled, signedIn: false, tier: null })),
      "free",
      `loading with accountsEnabled=${accountsEnabled}`,
    );
  }
});

test("accounts switched off entirely is a settled answer, not a failure, and stays open", () => {
  assert.equal(
    realSessionTier(account({ phase: "ready", accountsEnabled: false, signedIn: true, tier: "ai" })),
    "free",
  );
});

test("a real answer that says signed out is anonymous, same as a visitor", () => {
  assert.equal(
    realSessionTier(account({ phase: "ready", accountsEnabled: true, signedIn: false, tier: null })),
    "anonymous",
  );
});

test("a resolved, signed-in answer reports the real tier untouched", () => {
  for (const tier of ["tracking", "ai", "admin"]) {
    assert.equal(
      realSessionTier(account({ phase: "ready", accountsEnabled: true, signedIn: true, tier })),
      tier,
    );
  }
  // "free" the tier value and "free" the fallback are the same answer either
  // way, so this is the one row the table cannot tell apart from a made-up
  // tier name — included anyway, so a future tier added to the ladder above
  // without a matching branch here fails loudly instead of quietly mapping
  // to Free by accident.
  assert.equal(
    realSessionTier(account({ phase: "ready", accountsEnabled: true, signedIn: true, tier: "free" })),
    "free",
  );
});
