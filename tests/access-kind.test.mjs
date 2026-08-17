/*
  A date on a paid account means one of two opposite things, and the screens now
  have to say which.

  A card subscription renews on its `current_period_end`. An Alipay or WeChat Pay
  pass ends on it, and the account drops back to Free. `resolve_entitlement`
  returns the same two fields for both — a tier and a date — so every billing
  screen printed "Renews on" for both, and for the pass holder that is false in
  the way that costs somebody their access with nothing said in advance.

  These tests pin the decision (lib/billing/access.ts), the one place the server
  answers it (/api/account/status), and the three screens that print it. Source
  assertions strip comments first, because a comment quoting the old wording must
  not be able to satisfy a test about the new wording.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const access = await import(
  pathToFileURL(join(process.cwd(), "lib", "billing", "access.ts")).href
);
const { PASS_PRICE_PREFIX, entitlementRenews, grantRenews, isPassGrant } = access;

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");
const code = (source) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

const END = "2026-09-17T04:00:00+00:00";

/** A `subscriptions` row, as `currentAccessGrants` reports one. */
function grant(over = {}) {
  return {
    provider: "stripe",
    tier: "plus",
    priceId: "price_live_plus_monthly",
    currentPeriodEnd: END,
    cancelAtPeriodEnd: false,
    ...over,
  };
}

/* --------------------------------------------------------------- one row -- */

test("a wallet pass is told from a subscription by the marker the database writes", () => {
  /*
    supabase/migrations/0016 writes `'wallet:' || plan_id` into external_price_id,
    and apply_stripe_prepaid_refund_event matches a refund against `wallet:%`. So
    this prefix already has a database function depending on it; it is not a
    convention invented for the browser.
  */
  assert.equal(PASS_PRICE_PREFIX, "wallet:");
  const sql = read("supabase", "migrations", "0016_prepaid_wallet_access.sql");
  assert.match(sql, /'wallet:' \|\| p_plan_id/);
  assert.match(sql, /external_price_id like 'wallet:%'/);

  assert.equal(isPassGrant(grant({ priceId: "wallet:plus-monthly" })), true);
  assert.equal(isPassGrant(grant()), false);
  assert.equal(isPassGrant(grant({ priceId: null })), false);
});

test("only a live subscription renews", () => {
  assert.equal(grantRenews(grant()), true);
  // A pass: paid once, nothing scheduled.
  assert.equal(grantRenews(grant({ priceId: "wallet:plus-yearly" })), false);
  // Cancelled, still inside the period it paid for.
  assert.equal(grantRenews(grant({ cancelAtPeriodEnd: true })), false);
  // The free Pro trial is a grant rather than a purchase.
  assert.equal(grantRenews(grant({ provider: "promo" })), false);
  // An App Store subscription renews in Apple rather than in Stripe, and it does
  // renew — nothing here may read it as a pass.
  assert.equal(grantRenews(grant({ provider: "apple" })), true);
});

/* ------------------------------------------------ which row the date is -- */

test("the row is found by matching the entitlement, not by re-sorting the rows", () => {
  const subscription = grant();
  const pass = grant({ priceId: "wallet:pro-monthly", tier: "pro", currentPeriodEnd: END });

  assert.equal(entitlementRenews({ tier: "plus", expiresAt: END }, [subscription, pass]), true);
  assert.equal(entitlementRenews({ tier: "pro", expiresAt: END }, [subscription, pass]), false);
});

test("the two timestamps are compared as instants, not as strings", () => {
  /*
    One value comes back through a composite type returned by an RPC and the other
    through a PostgREST select. Both are the same timestamptz column and neither is
    obliged to spell the offset the way the other does.
  */
  assert.equal(
    entitlementRenews({ tier: "plus", expiresAt: "2026-09-17T04:00:00Z" }, [grant()]),
    true,
  );
});

test("an unexplainable date claims nothing rather than guessing", () => {
  // No rows at all: the read failed, or the row moved on since.
  assert.equal(entitlementRenews({ tier: "plus", expiresAt: END }, []), null);
  // A row for another tier, or another date, is not this entitlement's row.
  assert.equal(entitlementRenews({ tier: "plus", expiresAt: END }, [grant({ tier: "pro" })]), null);
  assert.equal(
    entitlementRenews({ tier: "plus", expiresAt: END }, [
      grant({ currentPeriodEnd: "2027-01-01T00:00:00+00:00" }),
    ]),
    null,
  );
  // Nothing to explain.
  assert.equal(entitlementRenews({ tier: "free", expiresAt: null }, [grant()]), null);
  assert.equal(entitlementRenews({ tier: "plus", expiresAt: "not a date" }, [grant()]), null);
});

test("a pass bought on top of a running subscription still means money leaves on that date", () => {
  const subscription = grant();
  const pass = grant({ priceId: "wallet:plus-monthly" });
  assert.equal(entitlementRenews({ tier: "plus", expiresAt: END }, [pass, subscription]), true);
});

/* ------------------------------------------------------- where it is read -- */

test("the server answers it, and only asks the database when there is a date", () => {
  const source = code(read("app", "api", "account", "status", "route.ts"));

  assert.match(source, /renews,/, "the status response no longer carries `renews`");
  assert.match(source, /entitlementRenews\(entitlement, await currentAccessGrants\(user\.id\)\)/);
  /*
    The guard is the whole cost argument: this route runs on nearly every page,
    and a free account — which is most of them — must not pay for an extra read
    to be told there is no date to explain.
  */
  assert.match(source, /if \(user && entitlement\.expiresAt !== null\)/);
  /* An unreachable read leaves it null rather than failing the whole route. */
  assert.match(source, /let renews: boolean \| null = null/);
});

test("the read is a fixed five-column select, not a query a caller could shape", () => {
  const source = code(read("lib", "auth", "supabase.ts"));
  const start = source.indexOf("export async function currentAccessGrants");
  assert.ok(start > -1, "currentAccessGrants is gone");
  const fn = source.slice(start, source.indexOf("\n}", start));

  assert.match(fn, /status=in\.\(active,trialing\)/);
  assert.match(
    fn,
    /select=provider,tier,external_price_id,current_period_end,cancel_at_period_end/,
  );
  assert.match(fn, /isUuid\(userId\)/, "a user id that is not a uuid must not reach the query");
  assert.match(fn, /asServiceRole: true/);
});

/* ----------------------------------------------------------- the screens -- */

test("the usage meter has a label for each of the three answers", () => {
  const source = code(read("components", "billing", "UsageMeter.tsx"));
  assert.match(source, /renews === true \? "Plan renews"/);
  assert.match(source, /renews === false \? "Pass ends"/);
  assert.match(source, /"Access to"/);
  assert.doesNotMatch(
    source,
    /planRenewsAt/,
    "the prop still calls every date a renewal, which is the bug",
  );
});

test("the billing screens say what a pass is and when it ends", () => {
  const notice = code(read("app", "billing", "access-notice.tsx"));

  assert.match(notice, /state\.renews === true/);
  assert.match(notice, /state\.renews === false/);
  /* The pass holder's three facts: it is a pass, it does not renew, and access
     stops on the date — which is printed, not implied. */
  assert.match(notice, /pass runs to \{endsAt\}/);
  assert.match(notice, /does not renew/);
  assert.match(notice, /goes back to Free/);
  /* And the subscriber's, which must not have been turned into pass language. */
  assert.match(notice, /charged again on that date/);

  /* Both billing screens use the one component rather than two wordings. */
  for (const page of [
    ["app", "billing", "page.tsx"],
    ["app", "billing", "plan", "page.tsx"],
  ]) {
    const source = code(read(...page));
    assert.match(source, /<AccessNotice state=\{state\}/, `${page.join("/")} writes its own`);
  }

  /* The plan screen's old single line was "Renews on", for everybody. */
  const plan = code(read("app", "billing", "plan", "page.tsx"));
  assert.doesNotMatch(plan, /Renews on/);
});

test("a pass holder is not told to cancel a subscription they do not have", () => {
  const source = code(read("components", "billing", "PayingWhileFreeNotice.tsx"));
  /*
    Both halves, separately. The paragraph is the disclosure and the button is
    where it sends them, and either one left on the subscriber's wording tells a
    pass holder to go and cancel something that does not exist.
  */
  assert.match(source, /\{renews === false \? \(/, "the paragraph says the same to both payers");
  assert.match(
    source,
    /renews === false \? "See your plan and its dates"/,
    "the button sends a pass holder to cancel a subscription",
  );
  assert.match(source, /nothing to cancel/);
  /* The subscriber's wording is still there — this notice exists to tell them
     they may cancel and take the free trial instead. */
  assert.match(source, /cancel your subscription/);
});

test("a pass holder on the plans page is not offered a subscription's controls", () => {
  const source = code(read("app", "pricing", "PricingPlans.tsx"));
  assert.match(source, /account\.renews === false/);
  /* "Manage billing" opens Stripe's portal, which for a pass is a page with no
     subscription on it. It stays for the subscriber and the null case. */
  assert.match(source, /"Manage billing"/);
  /*
    And it says what the date means. One line, because measured at 1280x720 three
    lines of it put the bottom of that card 52px below the fold — see
    tests/pricing-payment-hierarchy.test.mjs.
  */
  assert.match(source, /Pass ends \$\{date\} — nothing to cancel/);
});
