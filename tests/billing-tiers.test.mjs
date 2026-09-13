/*
  The gate, tested exhaustively, because it is small enough to be.

  `tierAllows` is the whole of "may this tier use this feature?". It is a pure
  function of two values, so every pair can be enumerated — which is worth
  doing, because the failure mode is silent in both directions: a tier that
  wrongly allows something gives away a paid feature, and a tier that wrongly
  refuses one takes away something somebody paid for, and neither throws.

  Also pinned here: that the meter and the pricing page read the same numbers.
  Before lib/usage/limits.ts derived its figures from the catalogue, the page's
  promise and the limit actually enforced were two constants that agreed only
  by attention.
*/
import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const tiers = await import(pathToFileURL(join(process.cwd(), "lib", "billing", "tiers.ts")).href);
const limits = await import(pathToFileURL(join(process.cwd(), "lib", "usage", "limits.ts")).href);

const {
  FEATURES,
  MONTHLY_AI_CAPS,
  PAID_TIERS,
  PLANS,
  PLAN_IDS,
  SELLABLE_TIERS,
  TIERS,
  formatPrice,
  isPlanId,
  isWalletPaymentMethod,
  monthlyCap,
  perMonthEquivalent,
  plansForTier,
  pricesIn,
  tierAllows,
  tierHasAi,
  walletMethodList,
  walletMethodName,
  weeklyCap,
} = tiers;

/* ------------------------------------------------------------------ gate -- */

test("every tier and feature pair has a definite answer", () => {
  for (const tier of Object.keys(TIERS)) {
    for (const feature of FEATURES) {
      assert.equal(
        typeof tierAllows(tier, feature),
        "boolean",
        `${tier} × ${feature} did not produce an answer`,
      );
    }
  }
});

test("AI starts at AI, and the tiers below it get none of it", () => {
  for (const feature of ["define", "generate", "grade-writing", "grade-speaking", "tutor-chat"]) {
    assert.equal(tierAllows("free", feature), false, `free should not have ${feature}`);
    assert.equal(tierAllows("tracking", feature), false, `tracking should not have ${feature}`);
    assert.equal(tierAllows("ai", feature), true, `ai is missing ${feature}`);
    // The owner's own account is not a plan, but it must not be locked out of
    // the app it exists to exercise.
    assert.equal(tierAllows("admin", feature), true, `admin is missing ${feature}`);
  }
  assert.equal(tierHasAi("free"), false);
  assert.equal(tierHasAi("tracking"), false);
  assert.equal(tierHasAi("ai"), true);
});

test("progress-sync is a paid feature now, even though it costs nothing to serve", () => {
  // Costing nothing is why it *could* be free with any account; it no longer
  // is, because Tracking and AI are the only things left to sell once every
  // paper stopped being one of them. See PROGRESS_SYNC_TIERS.
  assert.equal(tierAllows("free", "progress-sync"), false, "free should not have progress-sync");
  assert.equal(tierAllows("tracking", "progress-sync"), true, "tracking lost progress-sync");
  assert.equal(tierAllows("ai", "progress-sync"), true, "ai lost progress-sync");
  assert.equal(tierAllows("admin", "progress-sync"), true, "admin lost progress-sync");
});

test("a paid tier is never worse off than the one below it", () => {
  // The mistake this catches is an allowance raised on one tier and forgotten
  // on the one above — which reads as a subscriber losing something by paying
  // more.
  let below = "free";
  for (const tier of PAID_TIERS) {
    for (const feature of FEATURES) {
      if (!tierAllows(below, feature)) continue;
      assert.equal(tierAllows(tier, feature), true, `${tier} is missing ${feature}`);
    }
    below = tier;
  }
  for (const feature of FEATURES) {
    assert.equal(tierAllows("admin", feature), true, `admin is missing ${feature}`);
  }
});

test("an unknown tier is refused, not waved through", () => {
  // Anything the database could return that this code does not recognise —
  // a tier added to a migration and not here, a typo, an injected string.
  for (const tier of ["", "Pro", "PRO", "premium", "undefined", "null", "__proto__", "toString"]) {
    assert.equal(
      tierAllows(tier, "tutor-chat"),
      false,
      `${JSON.stringify(tier)} was allowed a paid feature`,
    );
    assert.equal(tierAllows(tier, "define"), false);
  }
});

test("a feature name that does not exist is refused by every tier", () => {
  for (const tier of Object.keys(TIERS)) {
    assert.equal(tierAllows(tier, "not-a-feature"), false);
  }
});

/*
  monthlyCap and weeklyCap are tierAllows's own arithmetic, and each has its
  own guard against a tier the catalogue does not recognise — proved directly
  rather than only through tierAllows, because indexing a missing tier without
  the guard does not merely answer wrong, it throws (MONTHLY_AI_CAPS[tier] is
  undefined), which a test that only ever calls tierAllows would never expose.
*/
test("monthlyCap and weeklyCap refuse an unrecognised tier with zero, not a thrown error", () => {
  assert.equal(monthlyCap("bogus-tier", "define"), 0);
  assert.equal(weeklyCap("bogus-tier", "define"), 0);
});

test("weeklyCap reads the same table monthlyCap does, tier by tier", () => {
  assert.equal(weeklyCap("free", "define"), 0);
  assert.equal(weeklyCap("tracking", "chat"), 0);
  assert.equal(weeklyCap("ai", "define"), 10);
  assert.equal(weeklyCap("ai", "chat"), 5);
  assert.equal(weeklyCap("ai", "grade/writing"), 2);
  assert.equal(weeklyCap("admin", "define"), null, "the owner's account must stay uncapped");
});

/* ------------------------------------------------------- quotas and copy -- */

test("the meter is handed exactly the allowances the catalogue defines", () => {
  const forDatabase = limits.limitsForDatabase();
  for (const tier of [...SELLABLE_TIERS, "admin"]) {
    for (const route of limits.AI_ROUTES) {
      assert.equal(
        forDatabase.monthly[tier][route],
        monthlyCap(tier, route),
        `${tier}.${route} is metered at a different number than the page promises`,
      );
    }
  }
});

test("an un-migrated database refuses AI rather than uncapping it", () => {
  /*
    The flat per-tier keys are the pre-0012 shape. A database that has not had
    supabase/migrations/0012_route_limits.sql applied reads only those, so they
    must all be zero: a missing key reads as unlimited on the old function, and
    a real number there would enforce the wrong cap silently. Admin stays null
    so the owner's account still works and can diagnose it.
  */
  const forDatabase = limits.limitsForDatabase();
  for (const tier of SELLABLE_TIERS) {
    assert.equal(forDatabase[tier], 0, `${tier} would be metered wrongly by an old database`);
  }
  assert.equal(forDatabase.admin, null);
  assert.equal(forDatabase.anonymous, 0);
  assert.equal(forDatabase.schema, limits.LIMITS_SCHEMA_VERSION);
});

test("the database is handed every bucket the meter knows how to read", () => {
  const forDatabase = limits.limitsForDatabase();
  assert.deepEqual(Object.keys(forDatabase).sort(), [
    "admin",
    "ai",
    "anonymous",
    "daily",
    "free",
    "ip",
    "monthly",
    "month_seconds",
    "schema",
    "tracking",
  ].sort());
  // A copy, not the live object: the meter must not be able to edit policy.
  forDatabase.monthly.ai.chat = 9999;
  assert.equal(MONTHLY_AI_CAPS.ai.chat, monthlyCap("ai", "chat"));
  assert.notEqual(monthlyCap("ai", "chat"), 9999);
});

test("every tier shown on the pricing page has something to say for itself", () => {
  for (const id of SELLABLE_TIERS) {
    const tier = TIERS[id];
    assert.ok(tier.name.length > 0, `${id} has no name`);
    assert.ok(tier.blurb.length > 0, `${id} has no blurb`);
    assert.ok(tier.includes.length > 0, `${id} lists nothing it includes`);
  }
});

/*
  The exact bullets on each card, not just that they exist. These are sales
  copy a learner reads before paying, and a mutant that silently blanked one
  bullet or dropped one from the list would still leave three good-looking
  ones behind it — "lists nothing it includes" above would not notice a list
  that lists almost nothing.
*/
test("the free tier's bullets are exactly what free has always meant here", () => {
  assert.deepEqual(TIERS.free.includes, [
    "Placement test, study plan and all drills — unlimited",
    "Every reading, listening, writing and speaking paper, no weekly limit",
    "The full mock exam, all four skills, timed",
    "Writing and speaking handed back to you after you submit — no AI score",
    "Results stay in this browser tab only — Tracking keeps them",
  ]);
});

test("the tracking tier's bullets are exactly what tracking adds on top of free", () => {
  assert.deepEqual(TIERS.tracking.includes, [
    "Everything in Free",
    "Every sitting saved, synced across your devices",
    "Your band trend and standing, any time",
    "Cancel any time, one button",
  ]);
});

test("the ai tier's bullets are exactly what ai adds on top of tracking", () => {
  assert.deepEqual(TIERS.ai.includes, [
    "Everything in Tracking",
    "5 essays and 3 speaking tests marked a month",
    "20 tutor questions and 40 word lookups a month",
    "1 fresh AI-written paper a month",
    "Cancel any time, one button",
  ]);
});

test("the owner's own account is named, not titled, and sells nothing", () => {
  assert.equal(TIERS.admin.name, "Adam");
  assert.equal(TIERS.admin.blurb, "Your own account. No limits on anything.");
  assert.deepEqual(TIERS.admin.includes, []);
});

/* ------------------------------------------------------------------ plans -- */

test("only plan ids this app defined are accepted", () => {
  for (const id of PLAN_IDS) assert.equal(isPlanId(id), true);
  // The shape of the attack this refuses: a caller naming a Stripe Price, or
  // a plan that used to exist and was withdrawn.
  for (const bad of ["price_1234", "pro", "", null, undefined, 7, {}, ["pro-monthly"]]) {
    assert.equal(isPlanId(bad), false, `${JSON.stringify(bad)} was accepted as a plan`);
  }
});

test("no plan sells the free tier or the owner's account", () => {
  for (const id of PLAN_IDS) {
    assert.notEqual(PLANS[id].tier, "free");
    assert.notEqual(PLANS[id].tier, "admin");
  }
  assert.deepEqual(plansForTier("free"), []);
  assert.deepEqual(plansForTier("admin"), []);
  // Every paid tier is sold monthly and yearly, and between them they account
  // for every plan id.
  let total = 0;
  for (const tier of PAID_TIERS) {
    const plans = plansForTier(tier);
    assert.equal(plans.length, 2, `${tier} should be sold monthly and yearly`);
    assert.deepEqual(
      plans.map((p) => p.interval).sort(),
      ["month", "year"],
      `${tier} is missing an interval`,
    );
    total += plans.length;
  }
  assert.equal(total, PLAN_IDS.length);
});

test("the ladder goes up, and every step is a real price", () => {
  let below = 0;
  for (const tier of PAID_TIERS) {
    const monthly = plansForTier(tier).find((p) => p.interval === "month");
    assert.ok(monthly.amountMinor > below, `${tier} does not cost more than the tier below it`);
    below = monthly.amountMinor;
  }
});

test("the yearly plan costs less per month than the monthly one", () => {
  // Not a marketing claim in a string: the two numbers, compared.
  for (const tier of PAID_TIERS) {
    const monthly = plansForTier(tier).find((p) => p.interval === "month");
    const yearly = plansForTier(tier).find((p) => p.interval === "year");
    assert.ok(
      perMonthEquivalent(yearly) < monthly.amountMinor,
      `${tier} yearly is not cheaper per month than ${tier} monthly`,
    );
    assert.equal(perMonthEquivalent(monthly), monthly.amountMinor);
    assert.equal(perMonthEquivalent(yearly), Math.round(yearly.amountMinor / 12));
  }
  assert.ok(PLANS["ai-monthly"].amountMinor > 0);
});

test("prices are formatted with two decimal places", () => {
  assert.equal(formatPrice(900, "usd"), "$9.00");
  assert.equal(formatPrice(7200, "usd"), "$72.00");
  assert.equal(formatPrice(600, "usd"), "$6.00");
  assert.equal(formatPrice(799, "usd"), "$7.99");
  assert.equal(formatPrice(0, "usd"), "$0.00");
});

test("pricesIn reads the currency case-insensitively, same as the rest of this module", () => {
  assert.equal(pricesIn("usd"), true);
  assert.equal(pricesIn("USD"), true);
  assert.equal(pricesIn("hkd"), true);
  assert.equal(pricesIn("xyz"), false, "a currency the catalogue never priced must read as unpriced");
});

/* --------------------------------------------------------- wallet copy -- */

test("walletMethodName spells out what the buyer sees on the button", () => {
  assert.equal(walletMethodName("alipay"), "Alipay");
  assert.equal(walletMethodName("wechat_pay"), "WeChat Pay");
});

test("walletMethodList joins however many wallets are actually offered", () => {
  assert.equal(walletMethodList([]), "");
  assert.equal(walletMethodList(["alipay"]), "Alipay");
  assert.equal(walletMethodList(["wechat_pay"]), "WeChat Pay");
  assert.equal(walletMethodList(["alipay", "wechat_pay"]), "Alipay or WeChat Pay");
  /*
    WALLET_PAYMENT_METHODS only ever has two entries, so a real call site
    never passes three — but the join logic itself is general-purpose list
    formatting ("all but the last, joined, then ' or ' the last"), and with
    only ever two real entries "drop the last element" and "keep the first
    element" produce the same array. A third entry is the only way to tell
    them apart.
  */
  assert.equal(
    walletMethodList(["alipay", "wechat_pay", "alipay"]),
    "Alipay, WeChat Pay or Alipay",
  );
});

test("isWalletPaymentMethod recognises exactly the two wallets, string or not", () => {
  assert.equal(isWalletPaymentMethod("alipay"), true);
  assert.equal(isWalletPaymentMethod("wechat_pay"), true);
  assert.equal(isWalletPaymentMethod("paypal"), false);
  assert.equal(isWalletPaymentMethod(""), false);
  for (const notAMethod of [42, null, undefined, {}, ["alipay"], true]) {
    assert.equal(isWalletPaymentMethod(notAMethod), false, `${JSON.stringify(notAMethod)} is not a wallet method`);
  }
});

/*
  What a plan is advertised as including, against what the meter will actually
  allow.

  These two live apart — one is marketing copy in `TIERS[...].includes`, the
  other is arithmetic in `MONTHLY_AI_CAPS` — and they drifted the first time the
  caps moved: the caps were halved to bring the prices down and the copy went on
  promising twenty marked essays where the meter would allow ten.

  That is not a display bug. It is a page taking somebody's money for a thing it
  then refuses to deliver, and under the consumer law this app already writes
  about on /terms it is the kind of thing that has to be refunded on request. So
  the numbers in the sales copy are checked against the numbers in the meter.
*/
test("the plan features promise no more than the meter allows", () => {
  const ROUTES = {
    essays: "grade/writing",
    "speaking tests": "grade/speaking",
    "tutor questions": "chat",
    "word lookups": "define",
    "AI-written papers": "generate",
  };

  for (const tier of ["ai"]) {
    const caps = MONTHLY_AI_CAPS[tier];
    const copy = TIERS[tier].includes.join(" ");

    for (const [phrase, route] of Object.entries(ROUTES)) {
      /*
        The "s" is optional because the copy is meant to read correctly, and
        "1 fresh AI-written papers" does not. Plus's generate cap moved to 1
        when generate: 2/5 -&gt; 1/2 paid for the speaking examiner (see
        lib/billing/tiers.ts), so this now has to match a singular count too.
      */
      const singular = phrase.endsWith("s") ? phrase.slice(0, -1) : phrase;
      const found = copy.match(new RegExp(String.raw`(\d+)\s+(?:fresh\s+)?` + singular + "s?"));
      assert.ok(found, `${tier} does not say how many ${phrase} it includes`);
      assert.equal(
        Number(found[1]),
        caps[route],
        `${tier} advertises ${found[1]} ${phrase} a month but the meter allows ${caps[route]}`,
      );
    }
  }
});
