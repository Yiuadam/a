/*
  createCheckoutSession and createPortalSession — the two Stripe-call-making
  functions in lib/billing/stripe.ts that neither wallet-checkout.test.mjs
  (createWalletCheckoutSession) nor price-catalogue-verification.test.mjs
  (priceCatalogueFault, verifyCataloguePrices) exercises — plus the transport
  both of them, and every other Stripe call in the module, sit on: the exact
  request form(), the bearer header, and stripePost/stripeGet's four failure
  modes (no key, the network itself failing, a response that is not JSON, and
  a non-2xx refusal). And the one property every one of those calls shares:
  none of them may run outside the server.

  The pattern below mirrors wallet-checkout.test.mjs's `walletSession` — stub
  `fetch`, call the real function, read back what it actually sent.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);
const stripe = await load("lib", "billing", "stripe.ts");
const tiers = await load("lib", "billing", "tiers.ts");

const { PLANS } = tiers;
const USER_ID = "11111111-1111-4111-8111-111111111111";

const PRICE_VARS = {
  "tracking-monthly": "STRIPE_PRICE_TRACKING_MONTHLY",
  "tracking-yearly": "STRIPE_PRICE_TRACKING_YEARLY",
  "ai-monthly": "STRIPE_PRICE_AI_MONTHLY",
  "ai-yearly": "STRIPE_PRICE_AI_YEARLY",
};

/** A Stripe Price object that agrees with the catalogue for `plan` — what
    assertPriceMatchesCatalogue must accept before a Session is ever made.
    currency_options deliberately omits the base currency, which is how
    Stripe's own API actually shapes it (see price-catalogue-verification). */
function goodPrice(plan) {
  const expected = PLANS[plan];
  const currency_options = {};
  for (const [code, unit_amount] of Object.entries(expected.prices)) {
    if (code === expected.currency) continue;
    currency_options[code] = { unit_amount };
  }
  return {
    active: true,
    unit_amount: expected.amountMinor,
    currency: expected.currency,
    recurring: { interval: expected.interval },
    currency_options,
  };
}

const checkoutArgs = (overrides = {}) => ({
  plan: "ai-monthly",
  tier: "ai",
  userId: USER_ID,
  email: null,
  successUrl: "https://bandup.life/billing?checkout=done",
  cancelUrl: "https://bandup.life/pricing?checkout=cancelled",
  ...overrides,
});

/**
 * Runs `fn(requests)` with STRIPE_SECRET_KEY and every plan's Price id set,
 * against a stub Stripe that serves GET /prices/:id from `priceFor` (default:
 * the catalogue's own price, so the guard passes) and POST .../sessions with
 * a fixed url — every request is logged to the array `fn` receives.
 * `onRequest`, when given, is asked first and can short-circuit any request
 * by returning a Response-shaped value, or answer nothing to fall through.
 */
async function withStripeEnv(fn, { priceFor = goodPrice, onRequest } = {}) {
  const saved = { key: process.env.STRIPE_SECRET_KEY, fetch: globalThis.fetch };
  process.env.STRIPE_SECRET_KEY = "sk_test_checkout_sessions";
  for (const [plan, name] of Object.entries(PRICE_VARS)) {
    saved[name] = process.env[name];
    process.env[name] = `price_${plan}`;
  }
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const record = { url: String(url), method: init.method ?? "GET", init, parsed };
    requests.push(record);
    if (onRequest) {
      const response = await onRequest(parsed, init, requests);
      if (response) return response;
    }
    if (parsed.pathname.startsWith("/v1/prices/")) {
      const id = decodeURIComponent(parsed.pathname.slice("/v1/prices/".length));
      const plan = id.replace(/^price_/, "");
      return new Response(JSON.stringify(priceFor(plan)), { status: 200 });
    }
    if (parsed.pathname === "/v1/checkout/sessions" || parsed.pathname === "/v1/billing_portal/sessions") {
      return new Response(JSON.stringify({ url: "https://checkout.stripe.test/session" }), { status: 200 });
    }
    throw new Error(`test stub has no route for ${record.method} ${parsed.pathname}`);
  };
  try {
    return await fn(requests);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = saved.key;
    for (const name of Object.values(PRICE_VARS)) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

/* -------------------------------------------------- createCheckoutSession -- */

test("createCheckoutSession sends the exact subscription form Stripe needs", () =>
  withStripeEnv(async (requests) => {
    const url = await stripe.createCheckoutSession(
      checkoutArgs({ email: "learner@example.test" }),
    );
    assert.equal(url, "https://checkout.stripe.test/session");

    const created = requests.find((r) => r.parsed.pathname === "/v1/checkout/sessions");
    assert.ok(created, "no Checkout Session was created");
    assert.equal(created.method, "POST");
    const body = new URLSearchParams(created.init.body);
    assert.equal(body.get("mode"), "subscription");
    // Off deliberately — see the source comment on why this line has its own
    // build-time test (tests/ai-economics.test.mjs) as well as this one.
    assert.equal(body.get("managed_payments[enabled]"), "false");
    assert.equal(body.get("line_items[0][price]"), "price_ai-monthly");
    assert.equal(body.get("line_items[0][quantity]"), "1");
    assert.equal(body.get("success_url"), "https://bandup.life/billing?checkout=done");
    assert.equal(body.get("cancel_url"), "https://bandup.life/pricing?checkout=cancelled");
    assert.equal(body.get("client_reference_id"), USER_ID);
    assert.equal(body.get("customer_email"), "learner@example.test");
    assert.equal(body.get("metadata[bandup_user_id]"), USER_ID);
    // The one that matters: still present on customer.subscription.updated two
    // years later, long after the Session itself is gone.
    assert.equal(body.get("subscription_data[metadata][bandup_user_id]"), USER_ID);
    assert.equal(body.get("subscription_data[metadata][bandup_tier]"), "ai");
  }));

test("createCheckoutSession omits customer_email rather than sending the string \"undefined\"", () =>
  withStripeEnv(async (requests) => {
    await stripe.createCheckoutSession(checkoutArgs({ email: null }));
    const created = requests.find((r) => r.parsed.pathname === "/v1/checkout/sessions");
    const body = new URLSearchParams(created.init.body);
    assert.equal(
      body.has("customer_email"),
      false,
      `customer_email should be absent, not "${body.get("customer_email")}"`,
    );
  }));

test("createCheckoutSession refuses to sell a Price that disagrees with the catalogue, before any Session exists", () =>
  withStripeEnv(
    async (requests) => {
      await assert.rejects(
        stripe.createCheckoutSession(checkoutArgs()),
        /charges 100 but the catalogue advertises 890/,
      );
      assert.equal(
        requests.some((r) => r.parsed.pathname === "/v1/checkout/sessions"),
        false,
        "a Session was created for a plan whose Price does not match the catalogue",
      );
    },
    { priceFor: (plan) => ({ ...goodPrice(plan), unit_amount: 100 }) },
  ));

test("createCheckoutSession refuses a plan with no Price id configured, and names the plan", () =>
  withStripeEnv(async () => {
    delete process.env.STRIPE_PRICE_AI_MONTHLY;
    await assert.rejects(
      stripe.createCheckoutSession(checkoutArgs({ plan: "ai-monthly" })),
      /no Price id configured for ai-monthly/,
    );
  }));

test("createCheckoutSession returns null when Stripe's session carries no usable url", () =>
  withStripeEnv(
    async () => {
      const url = await stripe.createCheckoutSession(checkoutArgs());
      assert.equal(url, null);
    },
    {
      onRequest: async (parsed) =>
        parsed.pathname === "/v1/checkout/sessions"
          ? new Response(JSON.stringify({ url: "" }), { status: 200 })
          : null,
    },
  ));

/* ---------------------------------------------------- createPortalSession -- */

test("createPortalSession sends the customer and the return url, and reports Stripe's own url back", () =>
  withStripeEnv(async (requests) => {
    const url = await stripe.createPortalSession({
      customerId: "cus_42",
      returnUrl: "https://bandup.life/billing",
    });
    assert.equal(url, "https://checkout.stripe.test/session");
    const created = requests.find((r) => r.parsed.pathname === "/v1/billing_portal/sessions");
    assert.ok(created, "no Portal Session was created");
    assert.equal(created.method, "POST");
    const body = new URLSearchParams(created.init.body);
    assert.equal(body.get("customer"), "cus_42");
    assert.equal(body.get("return_url"), "https://bandup.life/billing");
  }));

async function portalUrlFor(responseBody) {
  return withStripeEnv(
    () => stripe.createPortalSession({ customerId: "cus_42", returnUrl: "https://bandup.life/billing" }),
    {
      onRequest: async (parsed) =>
        parsed.pathname === "/v1/billing_portal/sessions"
          ? new Response(JSON.stringify(responseBody), { status: 200 })
          : null,
    },
  );
}

test("createPortalSession returns null when Stripe's session carries no usable url", async () => {
  assert.equal(await portalUrlFor({}), null, "a missing url produced a url");
  // url="" is the case that actually exercises the length boundary — an
  // absent url (undefined) already fails on typeof alone, before length is
  // ever read.
  assert.equal(await portalUrlFor({ url: "" }), null, "an empty-string url produced a url");
});

/* --------------------------------------------------------- the transport -- */

test("stripePost and stripeGet each send a bearer token, and only stripePost declares a body content type", () =>
  withStripeEnv(async (requests) => {
    await stripe.createCheckoutSession(checkoutArgs());
    const get = requests.find((r) => r.parsed.pathname.startsWith("/v1/prices/"));
    const post = requests.find((r) => r.parsed.pathname === "/v1/checkout/sessions");
    assert.equal(get.method, "GET");
    assert.equal(get.init.headers.Authorization, "Bearer sk_test_checkout_sessions");
    assert.equal(post.method, "POST");
    assert.equal(post.init.headers.Authorization, "Bearer sk_test_checkout_sessions");
    assert.equal(post.init.headers["Content-Type"], "application/x-www-form-urlencoded");
  }));

test("stripePost and stripeGet each refuse when no Stripe key is configured, and say so by name", () =>
  withStripeEnv(async () => {
    delete process.env.STRIPE_SECRET_KEY;
    // createPortalSession only ever calls stripePost.
    await assert.rejects(
      stripe.createPortalSession({ customerId: "cus_1", returnUrl: "https://bandup.life/billing" }),
      /Stripe is not configured/,
    );
    // billingSnapshot only ever calls stripeGet — unlike createCheckoutSession,
    // nothing downstream of it would also trip the same check and mask a
    // dropped one here.
    await assert.rejects(stripe.billingSnapshot(), /Stripe is not configured/);
  }));

test("a network failure talking to Stripe is wrapped with which request failed and why", () =>
  withStripeEnv(
    async () => {
      await assert.rejects(
        stripe.createPortalSession({ customerId: "cus_1", returnUrl: "https://bandup.life/billing" }),
        /request to \/billing_portal\/sessions failed: TypeError/,
      );
    },
    {
      onRequest: async (parsed) => {
        if (parsed.pathname === "/v1/billing_portal/sessions") throw new TypeError("fetch failed");
        return null;
      },
    },
  ));

test("a network failure that is not even an Error still names the request, not the value thrown", () =>
  withStripeEnv(
    async () => {
      await assert.rejects(
        stripe.createPortalSession({ customerId: "cus_1", returnUrl: "https://bandup.life/billing" }),
        /request to \/billing_portal\/sessions failed: unknown/,
      );
    },
    {
      onRequest: async (parsed) => {
        // Deliberately not an Error, to prove the "unknown" fallback is used.
        if (parsed.pathname === "/v1/billing_portal/sessions") throw "boom";
        return null;
      },
    },
  ));

test("a response Stripe sends that is not JSON is reported as a refusal naming the status, not returned as an empty body", () =>
  withStripeEnv(
    async () => {
      // If the parse failure's catch were emptied, `payload` would stay
      // undefined and .url would be read off it without complaint instead of
      // this message ever being thrown — so the exact text proves both that
      // it throws, and what it says.
      await assert.rejects(
        stripe.createPortalSession({ customerId: "cus_1", returnUrl: "https://bandup.life/billing" }),
        /response from \/billing_portal\/sessions was not JSON \(200\)/,
      );
    },
    {
      onRequest: async (parsed) =>
        parsed.pathname === "/v1/billing_portal/sessions"
          ? {
              ok: true,
              status: 200,
              json: async () => {
                throw new Error("not json");
              },
            }
          : null,
    },
  ));

test("the GET side of the transport wraps a network failure and a non-JSON response the same way", () =>
  withStripeEnv(
    async (requests) => {
      await assert.rejects(
        stripe.createCheckoutSession(checkoutArgs()),
        /request to \/prices\/price_ai-monthly.*failed: TypeError/,
      );
      assert.equal(requests.length, 1, "the checkout Session was still created after the price read failed");
    },
    {
      onRequest: async (parsed) => {
        if (parsed.pathname.startsWith("/v1/prices/")) throw new TypeError("boom");
        return null;
      },
    },
  ));

test("a GET-side network failure that is not even an Error still names the request, not the value thrown", () =>
  withStripeEnv(
    async () => {
      await assert.rejects(
        stripe.createCheckoutSession(checkoutArgs()),
        /request to \/prices\/price_ai-monthly.*failed: unknown/,
      );
    },
    {
      onRequest: async (parsed) => {
        if (parsed.pathname.startsWith("/v1/prices/")) throw "boom";
        return null;
      },
    },
  ));

test("a non-JSON response reading a Price is a refusal naming the status", () =>
  withStripeEnv(
    async () => {
      await assert.rejects(
        stripe.createCheckoutSession(checkoutArgs()),
        /response from \/prices\/price_ai-monthly.*was not JSON \(200\)/,
      );
    },
    {
      onRequest: async (parsed) =>
        parsed.pathname.startsWith("/v1/prices/")
          ? {
              ok: true,
              status: 200,
              json: async () => {
                throw new Error("not json");
              },
            }
          : null,
    },
  ));

test("financialSnapshot refuses a period whose starting or ending date cannot be parsed", async () => {
  const validPeriod = { days: 1, startingAt: "2026-01-01T00:00:00.000Z", endingAt: "2026-01-02T00:00:00.000Z", timezone: "UTC" };
  await assert.rejects(
    stripe.financialSnapshot({ ...validPeriod, endingAt: "not-a-date" }, "2026-01-01T00:00:00.000Z"),
    /Invalid financial report period/,
  );
  await assert.rejects(
    stripe.financialSnapshot(validPeriod, "not-a-date"),
    /Invalid financial report period/,
  );
});

/* ---------------------------------------------------------- server-only -- */

test("every Stripe-calling export refuses to run outside the server, and names this module", () =>
  withStripeEnv(async () => {
    globalThis.window = {};
    try {
      const attempts = [
        () => stripe.createPortalSession({ customerId: "cus_1", returnUrl: "https://bandup.life/billing" }),
        () => stripe.billingSnapshot(),
        () => stripe.verifyCataloguePrices(),
        () => stripe.stripeDiagnostic(),
        // Deliberately invalid dates: financialSnapshot's own assertServerOnly
        // is its very first line, before the date check that would otherwise
        // fire next. If assertServerOnly here were dropped, the invalid dates
        // would make the *next* line throw "Invalid financial report period"
        // instead — a different, distinguishable message — rather than this
        // call quietly reaching (and being masked by) stripeGet's own check.
        () =>
          stripe.financialSnapshot(
            { days: 30, startingAt: "not-a-date", endingAt: "also-not-a-date", timezone: "UTC" },
            "not-a-date-either",
          ),
      ];
      for (const attempt of attempts) {
        await assert.rejects(
          attempt(),
          /lib\/billing\/stripe\.ts is server-only and must not be imported from a client component/,
        );
      }
    } finally {
      delete globalThis.window;
    }
  }));
