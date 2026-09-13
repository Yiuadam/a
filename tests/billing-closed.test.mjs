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

/*
  Sets each named env var (undefined deletes it), runs fn, then restores every
  one of them to exactly what it was before — even the ones fn itself did not
  touch, so a test can never leak a Stripe var into the next one.
*/
async function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const ALL_PRICE_VARS = {
  STRIPE_PRICE_TRACKING_MONTHLY: undefined,
  STRIPE_PRICE_TRACKING_YEARLY: undefined,
  STRIPE_PRICE_AI_MONTHLY: undefined,
  STRIPE_PRICE_AI_YEARLY: undefined,
};

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

/* ------------------------------------------------------------- the readers */

/*
  Every reader in this file calls assertServerOnly(MODULE) first, so that a
  refactor which pulled one of them into a client component fails loudly in
  development rather than quietly handing back undefined. Proving it means
  actually tripping the guard: define `window`, the one thing assertServerOnly
  checks for, and confirm each reader throws with its own module name in the
  message — not merely that *a* throw happens, but that the specific dropped
  call and the specific module string are both still there.
*/
test("every reader refuses to run were it ever imported into a client component", () => {
  const saved = globalThis.window;
  globalThis.window = {};
  try {
    const readers = [
      () => env.billingClosed(),
      () => env.stripeSecretKey(),
      () => env.stripeWebhookSecret(),
      () => env.stripePriceId("tracking-monthly"),
      () => env.stripeWalletConfigured(),
      () => env.stripeWalletMethods(),
    ];
    for (const read of readers) {
      assert.throws(read, /lib\/billing\/env\.ts is server-only/);
    }
  } finally {
    if (saved === undefined) delete globalThis.window;
    else globalThis.window = saved;
  }
});

/*
  stripeSecretKey, stripeWebhookSecret and stripePriceId share one pattern:
  undefined and the empty string both mean "not set", and a value that has any
  length at all — including one that is only whitespace, which this deliberately
  does not trim — is handed back unchanged. The empty-string case is the one
  that actually distinguishes this from a bare `if (!value)`: `"" && ...` is
  already falsy without ever reading `.length`, so a mutant that forced the
  whole expression true is the only one an empty string can catch.
*/
test("stripeSecretKey treats unset and empty the same, and passes through whatever is set", async () => {
  await withEnv({ STRIPE_SECRET_KEY: undefined }, () => {
    assert.equal(env.stripeSecretKey(), undefined);
  });
  await withEnv({ STRIPE_SECRET_KEY: "" }, () => {
    assert.equal(env.stripeSecretKey(), undefined);
  });
  await withEnv({ STRIPE_SECRET_KEY: " " }, () => {
    assert.equal(env.stripeSecretKey(), " ", "a whitespace value is not trimmed, only emptiness is special-cased");
  });
  await withEnv({ STRIPE_SECRET_KEY: "sk_test_123" }, () => {
    assert.equal(env.stripeSecretKey(), "sk_test_123");
  });
});

test("stripeWebhookSecret treats unset and empty the same, and passes through whatever is set", async () => {
  await withEnv({ STRIPE_WEBHOOK_SECRET: undefined }, () => {
    assert.equal(env.stripeWebhookSecret(), undefined);
  });
  await withEnv({ STRIPE_WEBHOOK_SECRET: "" }, () => {
    assert.equal(env.stripeWebhookSecret(), undefined);
  });
  await withEnv({ STRIPE_WEBHOOK_SECRET: "whsec_test_123" }, () => {
    assert.equal(env.stripeWebhookSecret(), "whsec_test_123");
  });
});

test("stripePriceId treats unset and empty the same, and passes through whatever is set, per plan", async () => {
  await withEnv({ STRIPE_PRICE_AI_MONTHLY: undefined }, () => {
    assert.equal(env.stripePriceId("ai-monthly"), undefined);
  });
  await withEnv({ STRIPE_PRICE_AI_MONTHLY: "" }, () => {
    assert.equal(env.stripePriceId("ai-monthly"), undefined);
  });
  await withEnv({ STRIPE_PRICE_AI_MONTHLY: "price_ai_monthly_123" }, () => {
    assert.equal(env.stripePriceId("ai-monthly"), "price_ai_monthly_123");
    // And it reads the variable named for *that* plan, not a neighbour's.
    assert.notEqual(env.stripePriceId("ai-yearly"), "price_ai_monthly_123");
  });
});

/*
  stripeConfigured: a key, and at least one plan with a Price id behind it.
  Four scenarios are needed to pin both halves of the "and" and the
  some()-not-every() shape of the second half: no key alone is enough to
  refuse regardless of prices, and one price is enough to allow once a key
  exists — it does not take all four.
*/
test("stripeConfigured needs both a key and at least one priced plan — neither alone is enough", async () => {
  await withEnv({ STRIPE_SECRET_KEY: undefined, ...ALL_PRICE_VARS }, () => {
    assert.equal(env.stripeConfigured(), false, "no key and no prices");
  });
  await withEnv({ STRIPE_SECRET_KEY: undefined, ...ALL_PRICE_VARS, STRIPE_PRICE_TRACKING_MONTHLY: "price_x" }, () => {
    assert.equal(env.stripeConfigured(), false, "a price with no key must still refuse");
  });
  await withEnv({ STRIPE_SECRET_KEY: "sk_test", ...ALL_PRICE_VARS }, () => {
    assert.equal(env.stripeConfigured(), false, "a key with no prices at all must still refuse");
  });
  await withEnv({ STRIPE_SECRET_KEY: "sk_test", ...ALL_PRICE_VARS, STRIPE_PRICE_TRACKING_MONTHLY: "price_x" }, () => {
    assert.equal(env.stripeConfigured(), true, "one priced plan is enough — it need not be all four");
  });
  await withEnv(
    {
      STRIPE_SECRET_KEY: "sk_test",
      STRIPE_PRICE_TRACKING_MONTHLY: "price_1",
      STRIPE_PRICE_TRACKING_YEARLY: "price_2",
      STRIPE_PRICE_AI_MONTHLY: "price_3",
      STRIPE_PRICE_AI_YEARLY: "price_4",
    },
    () => {
      assert.equal(env.stripeConfigured(), true, "and of course true when every plan is priced");
    },
  );
});

/*
  stripeWalletConfigured: a key, the launch switch set to exactly "1", and at
  least one wallet method that actually parses. Wallet methods that are all
  unrecognised parse to an empty list — the one way to make
  stripeWalletMethods().length actually 0, which is what separates ">0" from
  the always-true ">=0" a mutant could substitute for it.
*/
test("stripeWalletConfigured needs a key, the launch switch, and at least one real wallet method", async () => {
  await withEnv(
    { STRIPE_SECRET_KEY: undefined, STRIPE_WALLET_PAYMENTS_ENABLED: "1", STRIPE_WALLET_METHODS: "alipay" },
    () => {
      assert.equal(env.stripeWalletConfigured(), false, "no key must refuse regardless of the rest");
    },
  );
  await withEnv(
    { STRIPE_SECRET_KEY: "sk_test", STRIPE_WALLET_PAYMENTS_ENABLED: undefined, STRIPE_WALLET_METHODS: "alipay" },
    () => {
      assert.equal(env.stripeWalletConfigured(), false, "the launch switch must be exactly \"1\", not merely present");
    },
  );
  await withEnv(
    { STRIPE_SECRET_KEY: "sk_test", STRIPE_WALLET_PAYMENTS_ENABLED: "true", STRIPE_WALLET_METHODS: "alipay" },
    () => {
      assert.equal(env.stripeWalletConfigured(), false, "\"true\" is not \"1\"");
    },
  );
  await withEnv(
    { STRIPE_SECRET_KEY: "sk_test", STRIPE_WALLET_PAYMENTS_ENABLED: "1", STRIPE_WALLET_METHODS: "bogus,invalid" },
    () => {
      assert.equal(env.stripeWalletConfigured(), false, "methods that all fail to parse leave nothing to offer");
    },
  );
  await withEnv(
    { STRIPE_SECRET_KEY: "sk_test", STRIPE_WALLET_PAYMENTS_ENABLED: "1", STRIPE_WALLET_METHODS: "alipay" },
    () => {
      assert.equal(env.stripeWalletConfigured(), true);
    },
  );
});

/*
  stripeWalletMethods: the default, and the parsing rules the header comment
  promises — a comma list, spaces trimmed, case folded, unknown entries
  dropped, and the result in catalogue order regardless of the order written.
*/
test("stripeWalletMethods defaults to Alipay alone when the variable is unset", async () => {
  await withEnv({ STRIPE_WALLET_METHODS: undefined }, () => {
    assert.deepEqual(env.stripeWalletMethods(), ["alipay"]);
  });
});

test("stripeWalletMethods trims spaces, folds case, drops unknown entries, and keeps catalogue order", async () => {
  await withEnv({ STRIPE_WALLET_METHODS: "alipay,wechat_pay" }, () => {
    assert.deepEqual(env.stripeWalletMethods(), ["alipay", "wechat_pay"]);
  });
  await withEnv({ STRIPE_WALLET_METHODS: "alipay, wechat_pay" }, () => {
    assert.deepEqual(
      env.stripeWalletMethods(),
      ["alipay", "wechat_pay"],
      "a space after the comma must not stop wechat_pay being recognised",
    );
  });
  await withEnv({ STRIPE_WALLET_METHODS: " ALIPAY , WECHAT_PAY " }, () => {
    assert.deepEqual(env.stripeWalletMethods(), ["alipay", "wechat_pay"]);
  });
  await withEnv({ STRIPE_WALLET_METHODS: "wechat_pay,alipay" }, () => {
    assert.deepEqual(
      env.stripeWalletMethods(),
      ["alipay", "wechat_pay"],
      "the Session must list them in catalogue order regardless of how the variable spells them",
    );
  });
  await withEnv({ STRIPE_WALLET_METHODS: "alipay,bogus,wechat_pay" }, () => {
    assert.deepEqual(env.stripeWalletMethods(), ["alipay", "wechat_pay"]);
  });
  await withEnv({ STRIPE_WALLET_METHODS: "bogus,invalid" }, () => {
    assert.deepEqual(env.stripeWalletMethods(), []);
  });
});

/*
  purchasablePlans: the same "a key, and this plan is priced" test as
  stripeConfigured, but per plan rather than collapsed to one boolean — the
  filter, not some(), is what has to run correctly here.
*/
test("purchasablePlans lists exactly the plans with a configured Price id, and nothing without a key", async () => {
  await withEnv({ STRIPE_SECRET_KEY: undefined, ...ALL_PRICE_VARS, STRIPE_PRICE_TRACKING_MONTHLY: "price_x" }, () => {
    assert.deepEqual(env.purchasablePlans(), [], "a price with no key must still list nothing");
  });
  await withEnv({ STRIPE_SECRET_KEY: "sk_test", ...ALL_PRICE_VARS }, () => {
    assert.deepEqual(env.purchasablePlans(), [], "a key with no prices at all must still list nothing");
  });
  await withEnv({ STRIPE_SECRET_KEY: "sk_test", ...ALL_PRICE_VARS, STRIPE_PRICE_TRACKING_MONTHLY: "price_x" }, () => {
    assert.deepEqual(env.purchasablePlans(), ["tracking-monthly"], "exactly the one priced plan, not all four");
  });
  await withEnv(
    {
      STRIPE_SECRET_KEY: "sk_test",
      STRIPE_PRICE_TRACKING_MONTHLY: "price_1",
      STRIPE_PRICE_TRACKING_YEARLY: "price_2",
      STRIPE_PRICE_AI_MONTHLY: "price_3",
      STRIPE_PRICE_AI_YEARLY: "price_4",
    },
    () => {
      assert.deepEqual(env.purchasablePlans(), ["tracking-monthly", "tracking-yearly", "ai-monthly", "ai-yearly"]);
    },
  );
});

/*
  tierForStripePrice: reading the configuration backwards, from a Price id to
  the tier it buys. Both a real match and a clean miss are needed — a mutant
  that always matches the first plan it checks would still pass a test that
  only ever asked about a Price the first plan actually owns.
*/
test("tierForStripePrice reads back the tier a configured Price id buys, and null for anything else", async () => {
  await withEnv({ ...ALL_PRICE_VARS, STRIPE_PRICE_AI_MONTHLY: "price_ai_monthly_here" }, () => {
    assert.equal(env.tierForStripePrice("price_ai_monthly_here"), "ai");
    assert.equal(env.tierForStripePrice("price_never_configured"), null);
  });
});
