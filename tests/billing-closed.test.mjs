/*
  BILLING_CLOSED: the deliberate, documented switch that lets the owner pause
  subscription sales without any of that reading as broken configuration.

  Before this switch existed, "closed" and "never configured" looked identical
  everywhere: the pricing page said checkout "aren't open yet", the checkout
  routes answered the same 503 either way, and the health check went red on
  the missing Price ids — which is exactly the shape of the 16 August failure,
  just for a reason that is not actually a fault. These tests pin the three
  places that now tell the two apart, and that the switch changes nothing
  about what a still-subscribed learner can do.

  Two more places were found still disagreeing after this file was first
  written, both mid-task rather than on the pricing page itself: the 402 a
  gated route returns (lib/billing/gate.ts's upgradeMessage()) went on
  pointing at "the plans on the pricing page", and the panel drawn under a
  locked feature (components/billing/UpgradePanel.tsx) went on showing a
  price button that led there — a dead end reached one click later rather
  than avoided. They are pinned below, alongside the original three.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);
/*
  gate.ts reaches lib/auth/errors.ts, which imports next/server — a subpath
  Next ships with no `exports` entry for, so plain ESM resolution cannot find
  it (webpack and CJS `require` both retry a `.js` suffix; ESM does not). This
  is the same redirect tests/cutover-write-barrier.test.mjs already proves
  works, reused rather than re-solved.
*/
register("./cutover-write-barrier-resolve.mjs", import.meta.url);

const env = await import(pathToFileURL(join(process.cwd(), "lib", "billing", "env.ts")).href);
const health = await import(pathToFileURL(join(process.cwd(), "lib", "billing", "health.ts")).href);
const messages = await import(
  pathToFileURL(join(process.cwd(), "lib", "billing", "messages.ts")).href
);
const gate = await import(pathToFileURL(join(process.cwd(), "lib", "billing", "gate.ts")).href);

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");

/** Runs `fn` with BILLING_CLOSED set to `value` (or unset, for `undefined`), restoring it after. */
function withBillingClosed(value, fn) {
  const saved = process.env.BILLING_CLOSED;
  if (value === undefined) delete process.env.BILLING_CLOSED;
  else process.env.BILLING_CLOSED = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.BILLING_CLOSED;
    else process.env.BILLING_CLOSED = saved;
  }
}

/* ------------------------------------------------------------ the switch -- */

test("billingClosed() is true only when BILLING_CLOSED is exactly \"1\", like ACCOUNTS_ENABLED", () => {
  const saved = process.env.BILLING_CLOSED;
  try {
    delete process.env.BILLING_CLOSED;
    assert.equal(env.billingClosed(), false, "unset must not read as closed");

    process.env.BILLING_CLOSED = "0";
    assert.equal(env.billingClosed(), false);

    process.env.BILLING_CLOSED = "true";
    assert.equal(env.billingClosed(), false, "only the literal \"1\" counts");

    process.env.BILLING_CLOSED = "1";
    assert.equal(env.billingClosed(), true);
  } finally {
    if (saved === undefined) delete process.env.BILLING_CLOSED;
    else process.env.BILLING_CLOSED = saved;
  }
});

test("BILLING_CLOSED lives in wrangler.jsonc as a plain var, not a Secret", () => {
  const text = readFileSync(join(process.cwd(), "wrangler.jsonc"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"])\/\/.*$/gm, "$1");
  const config = JSON.parse(text);
  assert.equal(
    config.vars?.BILLING_CLOSED,
    "1",
    "the owner's decision to pause sales, 2026-09-12, should be visible and reviewable in this file",
  );
});

/* --------------------------------------------------------- the pricing page */

test("the config route answers a fixed, empty shape when billing is closed, before computing plans", () => {
  const source = read("app", "api", "billing", "config", "route.ts");
  const closedAt = source.indexOf("if (billingClosed())");
  const plansAt = source.indexOf("purchasablePlans()");
  assert.ok(closedAt >= 0, "the config route must check billingClosed()");
  assert.ok(plansAt >= 0 && closedAt < plansAt, "billingClosed() must be checked before plans are computed");

  const block = source.slice(closedAt, plansAt);
  assert.match(block, /checkout:\s*false/);
  assert.match(block, /plans:\s*\[\]/);
  assert.match(block, /walletCheckout:\s*false/);
  assert.match(block, /walletMethods:\s*\[\]/);
  assert.match(block, /closed:\s*true/);
  // Currency is still sent — the empty state still has to be priced honestly
  // in the reader's own currency, exactly as the unavailable-Stripe case is.
  assert.match(block, /currency/);
});

test("PricingPlans renders the billingClosed message, and only when the config says so", () => {
  const source = read("app", "pricing", "PricingPlans.tsx");
  assert.match(
    source,
    /import \{ BILLING_MESSAGES \} from "@\/lib\/billing\/messages";/,
    "the page must read the shared sentence rather than writing its own",
  );
  assert.match(source, /closed\??:\s*boolean/, "BillingConfig must carry the closed field");

  // Gated on the closed flag inside the empty-state branch, not shown
  // unconditionally. Searched forward from that branch, rather than by a bare
  // indexOf on the message, because a why-comment earlier in the file also
  // names BILLING_MESSAGES.billingClosed in passing.
  const emptyStateAt = source.indexOf("!planOffered && !walletOffered");
  assert.ok(emptyStateAt >= 0, "the honest empty state branch must still exist");
  const closedIfAt = source.indexOf("if (closed)", emptyStateAt);
  assert.ok(closedIfAt >= 0, "the empty state must branch on the closed flag");
  const messageAt = source.indexOf("BILLING_MESSAGES.billingClosed", closedIfAt);
  assert.ok(
    messageAt >= 0 && messageAt - closedIfAt < 200,
    "the message must be rendered inside the if (closed) branch",
  );

  // And the fallback for "never configured" is still there, untouched.
  assert.match(source, /Payments aren&rsquo;t open yet/);
});

/* -------------------------------------------------------- the checkout routes */

for (const [route, configuredCall] of [
  ["checkout", "stripeConfigured()"],
  ["wallet-checkout", "stripeWalletConfigured()"],
]) {
  test(`${route} refuses with the billingClosed message before any Stripe work, even if Stripe would otherwise be configured`, () => {
    const source = read("app", "api", "billing", route, "route.ts");
    const closedAt = source.indexOf("billingClosed()");
    const configuredAt = source.indexOf(configuredCall);
    assert.ok(closedAt >= 0, `${route} must call billingClosed()`);
    assert.ok(configuredAt >= 0, `${route} must still call ${configuredCall}`);
    assert.ok(
      closedAt < configuredAt,
      `${route} must check billingClosed() before ${configuredCall}, so a configured Stripe never overrides a closed shop`,
    );

    // The closed branch is its own early return, not folded into the
    // configuration check's message — a subscriber pressing the button while
    // sales are paused is told a different fact from "never set up".
    const block = source.slice(closedAt, configuredAt);
    assert.match(block, /return safeJsonError\(BILLING_MESSAGES\.billingClosed, 503\)/);
  });
}

test("the portal and the webhook routes are not touched by billingClosed at all", () => {
  const portal = read("app", "api", "billing", "portal", "route.ts");
  const webhook = read("app", "api", "billing", "webhook", "stripe", "route.ts");
  assert.doesNotMatch(portal, /billingClosed/, "an existing subscriber must still reach the portal while paused");
  assert.doesNotMatch(webhook, /billingClosed/, "a renewal must still be recorded while paused");
});

/* --------------------------------------------------- the upgrade message (gate.ts) */

test("upgradeMessage points at the pricing page when sales are open", () =>
  withBillingClosed(undefined, () => {
    assert.equal(
      gate.upgradeMessage("progress-sync"),
      "This is part of BandUp Tracking. See the plans on the pricing page — everything else, including practice tests, drills and your study plan, stays free.",
    );
  }));

test("upgradeMessage says sales are paused instead, once BILLING_CLOSED is set", () =>
  withBillingClosed("1", () => {
    const message = gate.upgradeMessage("progress-sync");
    assert.equal(
      message,
      "This is part of BandUp Tracking. Subscriptions are paused for now — this will open when they resume. Everything else, including practice tests, drills and your study plan, stays free.",
    );
    // The old sentence sent a refused caller to compare plans on a page with
    // nothing to compare — the exact dead end this switch exists to close.
    assert.doesNotMatch(message, /pricing page/);
  }));

test("gate.ts reads BILLING_MESSAGES.subscriptionsPaused rather than writing its own words", () => {
  // A behavioural pin (above) proves the *output*; this proves the *source*
  // of it, so a future edit cannot make the two texts merely coincide.
  const source = read("lib", "billing", "gate.ts");
  assert.match(source, /import \{ billingClosed \} from "\.\/env";/);
  assert.match(source, /import \{ BILLING_MESSAGES \} from "\.\/messages";/);
  const fn = source.slice(source.indexOf("export function upgradeMessage"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /if \(billingClosed\(\)\)/);
  assert.match(body, /BILLING_MESSAGES\.subscriptionsPaused/);
});

/* -------------------------------------------------------------- the upgrade panel */

test("UpgradePanel asks /api/billing/config, the same shape the pricing page reads", () => {
  const source = read("components", "billing", "UpgradePanel.tsx");
  assert.match(source, /fetch\(apiUrl\("\/api\/billing\/config"\)\)/);
  assert.match(source, /closed\?:\s*boolean/, "reads the same optional closed field PricingPlans does");
  assert.match(source, /import \{ BILLING_MESSAGES \} from "@\/lib\/billing\/messages";/);
});

test("the panel swaps the price button for the paused sentence once config says closed", () => {
  const source = read("components", "billing", "UpgradePanel.tsx");

  // Sliced from the mobile/web fork to the next branch, rather than found by
  // a bare indexOf on the message, so this fails loudly if the closed branch
  // is ever moved outside the non-mobile CTA it is meant to replace.
  const nonMobileAt = source.indexOf("IS_MOBILE_BUILD ? (");
  const closedAt = source.indexOf(") : closed ? (", nonMobileAt);
  assert.ok(closedAt > nonMobileAt, "the closed branch must sit inside the non-mobile CTA");
  const openAt = source.indexOf(") : (", closedAt);
  const closedBlock = source.slice(closedAt, openAt);

  assert.match(closedBlock, /BILLING_MESSAGES\.subscriptionsPaused/);
  assert.match(closedBlock, /href="\/practice"/);
  assert.match(closedBlock, /Keep practising/);
  assert.doesNotMatch(
    closedBlock,
    /href="\/pricing"/,
    "the same dead end HistoryGate used to lead to — a price button for a shop with nothing to sell",
  );
});

test("the panel keeps today's button when sales are open, price and usage link both", () => {
  const source = read("components", "billing", "UpgradePanel.tsx");
  assert.match(source, /<Link href="\/pricing" className="btn-primary">/);
  assert.match(source, /<Link href="\/billing" className="btn-secondary">/);
  // The renewal/refund disclaimer names a button that is not on screen once
  // the shop is closed, so it is silent then too.
  assert.match(source, /\{!IS_MOBILE_BUILD && !closed && \(/);
});

/* ------------------------------------------------------------- the health check */

const PRICE_VARS = [
  "STRIPE_PRICE_TRACKING_MONTHLY",
  "STRIPE_PRICE_TRACKING_YEARLY",
  "STRIPE_PRICE_AI_MONTHLY",
  "STRIPE_PRICE_AI_YEARLY",
];
const HEALTH_VARS = [
  "BILLING_CLOSED",
  "ACCOUNTS_ENABLED",
  "STRIPE_WEBHOOK_SECRET",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "STRIPE_SECRET_KEY",
  ...PRICE_VARS,
];

/**
 * A deployment with everything else healthy, the four Price ids removed
 * (the actual closure mechanism), and Stripe reachable — then `overrides` on
 * top, so a caller decides only whether BILLING_CLOSED is set.
 */
function withClosedShopConfig(overrides, fn) {
  const saved = {};
  for (const key of HEALTH_VARS) saved[key] = process.env[key];
  process.env.ACCOUNTS_ENABLED = "1";
  process.env.SUPABASE_URL = "https://project.supabase.test";
  process.env.SUPABASE_ANON_KEY = "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  process.env.STRIPE_SECRET_KEY = "sk_test_billing_closed";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_billing_closed";
  for (const key of PRICE_VARS) delete process.env[key];
  delete process.env.BILLING_CLOSED;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const savedFetch = globalThis.fetch;
  // stripeDiagnostic() only ever asks /subscriptions — no Price is read once
  // the price-catalogue check is skipped, so nothing needs to answer /prices/.
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [], livemode: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = savedFetch;
      for (const key of HEALTH_VARS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

test("a closed shop with every Price id removed is reported healthy, and says why", () =>
  withClosedShopConfig({ BILLING_CLOSED: "1" }, async () => {
    const result = await health.billingHealth();
    assert.equal(result.ok, true);

    const names = result.checks.map((c) => c.name);
    assert.ok(names.includes("billing_closed_by_owner"));
    assert.equal(result.checks.find((c) => c.name === "billing_closed_by_owner").ok, true);

    // Not merely forced true: gone. Nothing here claims a Price catalogue was
    // verified when closing sales means there was nothing to verify.
    assert.ok(!names.includes("stripe_price_ids_present"));
    assert.ok(!names.includes("stripe_prices_match_catalogue"));

    // Renewals still need these, so they stay real, unforced checks.
    assert.equal(result.checks.find((c) => c.name === "stripe_key_present").ok, true);
    assert.equal(result.checks.find((c) => c.name === "stripe_webhook_secret_present").ok, true);
    assert.equal(result.checks.find((c) => c.name === "stripe_reachable").ok, true);

    for (const check of result.checks) {
      assert.deepEqual(Object.keys(check).sort(), ["name", "ok"]);
    }
  }));

test("with BILLING_CLOSED unset, a missing Price id is reported unhealthy exactly as before", () =>
  withClosedShopConfig({}, async () => {
    const result = await health.billingHealth();
    assert.equal(result.ok, false);

    const names = result.checks.map((c) => c.name);
    assert.ok(names.includes("stripe_price_ids_present"));
    assert.ok(!names.includes("billing_closed_by_owner"));
    assert.equal(result.checks.find((c) => c.name === "stripe_price_ids_present").ok, false);
    assert.equal(result.checks.find((c) => c.name === "stripe_prices_match_catalogue").ok, false);
  }));

/* ------------------------------------------------------------------ the copy */

test("the billingClosed message is a settled fact, quoted once and shared everywhere", () => {
  assert.equal(
    messages.BILLING_MESSAGES.billingClosed,
    "Subscriptions are paused for now. Everything on BandUp is free in the meantime — every paper, every skill, unlimited, the moment you sign in.",
  );
  // Distinct from the "never configured" sentence, deliberately.
  assert.notEqual(messages.BILLING_MESSAGES.billingClosed, messages.BILLING_MESSAGES.checkoutUnavailable);
});

test("the subscriptionsPaused message is a settled fact too, and a shorter one on purpose", () => {
  assert.equal(
    messages.BILLING_MESSAGES.subscriptionsPaused,
    "Subscriptions are paused for now — this will open when they resume.",
  );
  // Distinct from billingClosed above: that one is for the pricing page,
  // where the reassurance ("everything is free meanwhile") is the point.
  // This one is for a reader already mid-task, who does not need it repeated.
  assert.notEqual(
    messages.BILLING_MESSAGES.subscriptionsPaused,
    messages.BILLING_MESSAGES.billingClosed,
  );
});

test("the portal needs the secret key, not a Price id — a paused shop still lets subscribers manage billing", () => {
  const portal = read("app", "api", "billing", "portal", "route.ts");
  assert.match(portal, /!stripeSecretKey\(\)/);
  assert.doesNotMatch(portal, /stripeConfigured\(\)/);
});
