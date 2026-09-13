import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { register } from "node:module";

register("./alias-resolve.mjs", import.meta.url);

const stripe = await import(
  pathToFileURL(join(process.cwd(), "lib", "billing", "stripe.ts")).href
);
const env = await import(
  pathToFileURL(join(process.cwd(), "lib", "billing", "env.ts")).href
);
const tiers = await import(
  pathToFileURL(join(process.cwd(), "lib", "billing", "tiers.ts")).href
);
const currency = await import(
  pathToFileURL(join(process.cwd(), "lib", "billing", "currency.ts")).href
);

test("wallet checkout stays hidden until Stripe approval is explicitly confirmed", () => {
  const savedKey = process.env.STRIPE_SECRET_KEY;
  const savedSwitch = process.env.STRIPE_WALLET_PAYMENTS_ENABLED;
  process.env.STRIPE_SECRET_KEY = "sk_test_wallet_checkout";
  delete process.env.STRIPE_WALLET_PAYMENTS_ENABLED;
  try {
    assert.equal(env.stripeWalletConfigured(), false);
    process.env.STRIPE_WALLET_PAYMENTS_ENABLED = "1";
    assert.equal(env.stripeWalletConfigured(), true);
  } finally {
    if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = savedKey;
    if (savedSwitch === undefined) delete process.env.STRIPE_WALLET_PAYMENTS_ENABLED;
    else process.env.STRIPE_WALLET_PAYMENTS_ENABLED = savedSwitch;
  }
});

/** Runs one wallet session against a stubbed Stripe and returns the form it sent. */
async function walletSession(args = {}, env = {}) {
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.STRIPE_SECRET_KEY;
  const savedMethods = process.env.STRIPE_WALLET_METHODS;
  const requests = [];
  process.env.STRIPE_SECRET_KEY = "sk_test_wallet_checkout";
  if (env.STRIPE_WALLET_METHODS === undefined) delete process.env.STRIPE_WALLET_METHODS;
  else process.env.STRIPE_WALLET_METHODS = env.STRIPE_WALLET_METHODS;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ url: "https://checkout.stripe.test/session" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const url = await stripe.createWalletCheckoutSession({
      plan: "tracking-monthly",
      userId: "11111111-1111-4111-8111-111111111111",
      email: "learner@example.test",
      customerId: null,
      successUrl: "https://bandup.life/billing?checkout=done",
      cancelUrl: "https://bandup.life/pricing?checkout=cancelled",
      ...args,
    });
    assert.equal(url, "https://checkout.stripe.test/session");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = savedKey;
    if (savedMethods === undefined) delete process.env.STRIPE_WALLET_METHODS;
    else process.env.STRIPE_WALLET_METHODS = savedMethods;
  }
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.stripe.com/v1/checkout/sessions");
  return new URLSearchParams(requests[0].init.body);
}

/*
  Only the wallets the account is approved for.

  Naming one it is not approved for does not drop that wallet from the Session.
  Stripe refuses the whole Session:

    The payment method type provided: wechat_pay is invalid. Please ensure the
    provided type is activated in your dashboard.

  So listing an unapproved WeChat Pay alongside Alipay did not degrade to
  Alipay — it took Alipay down too, and every wallet payment on the live site
  failed. The default is Alipay alone because that is what is approved today.
*/
test("a wallet session lists only the approved wallets, Alipay by default", async () => {
  const body = await walletSession();

  assert.equal(body.get("payment_method_types[0]"), "alipay");
  assert.equal(body.get("payment_method_types[1]"), null, "an unapproved wallet was listed");
  assert.equal(
    body.get("payment_method_options[wechat_pay][client]"),
    null,
    "WeChat's option was sent without WeChat being offered",
  );
  assert.equal(body.get("mode"), "payment");
  assert.equal(body.get("managed_payments[enabled]"), "false");
});

test("approving WeChat Pay is one variable, and it brings its mandatory option", async () => {
  const body = await walletSession({}, { STRIPE_WALLET_METHODS: "alipay,wechat_pay" });

  assert.deepEqual(
    [body.get("payment_method_types[0]"), body.get("payment_method_types[1]")],
    ["alipay", "wechat_pay"],
  );
  /* Mandatory whenever wechat_pay is listed; its absence 400s the Session. */
  assert.equal(body.get("payment_method_options[wechat_pay][client]"), "web");
});

test("an unknown wallet name is ignored rather than sent to Stripe", async () => {
  const body = await walletSession({}, { STRIPE_WALLET_METHODS: "alipay, paypal ,WECHAT_PAY" });

  assert.deepEqual(
    [body.get("payment_method_types[0]"), body.get("payment_method_types[1]")],
    ["alipay", "wechat_pay"],
    "case and spacing should be tolerated, but an unsupported name must not be forwarded",
  );
  assert.equal(body.get("payment_method_types[2]"), null);
});

/*
  The base currency, always.

  This briefly used the reader's own currency, on the strength of Stripe's
  published tables saying both wallets accept it. The tables are not the whole
  story — support depends on the merchant's account and country — and Stripe
  does not degrade, it refuses:

    `payment_method_types` must include at least one payment method supported
    by the default currency `sgd`.

  Singapore dollars, for Alipay, which every table lists as supported.
*/
test("a wallet payment is always in the base currency", async () => {
  const body = await walletSession();
  const plan = tiers.PLANS["tracking-monthly"];

  assert.equal(body.get("line_items[0][price_data][currency]"), plan.currency);
  assert.equal(body.get("line_items[0][price_data][unit_amount]"), String(plan.amountMinor));
  assert.equal(body.get("metadata[bandup_plan_id]"), "tracking-monthly");
  assert.equal(body.get("customer_creation"), "always");
});

/*
  Every field a webhook or a human reading the dashboard depends on, in one
  place — the wallet session carries the account twice (metadata and
  payment_intent_data, because the PaymentIntent is what survives on the
  refund events) and the tier and plan id the checkout is actually for.
*/
test("a monthly wallet session names its product, tier, plan and account precisely", async () => {
  const body = await walletSession({ plan: "tracking-monthly" });
  const plan = tiers.PLANS["tracking-monthly"];
  const userId = "11111111-1111-4111-8111-111111111111";

  assert.equal(
    body.get("line_items[0][price_data][product_data][name]"),
    `${tiers.TIERS[plan.tier].name} — 1 month prepaid access`,
  );
  assert.equal(body.get("metadata[bandup_user_id]"), userId);
  assert.equal(body.get("metadata[bandup_tier]"), "tracking");
  assert.equal(body.get("metadata[bandup_plan_id]"), "tracking-monthly");
  assert.equal(body.get("payment_intent_data[metadata][bandup_user_id]"), userId);
  assert.equal(body.get("payment_intent_data[metadata][bandup_tier]"), "tracking");
  assert.equal(body.get("payment_intent_data[metadata][bandup_plan_id]"), "tracking-monthly");
});

test("a yearly wallet session says '1 year', never '1 month'", async () => {
  const body = await walletSession({ plan: "ai-yearly" });
  const plan = tiers.PLANS["ai-yearly"];

  assert.equal(
    body.get("line_items[0][price_data][product_data][name]"),
    `${tiers.TIERS[plan.tier].name} — 1 year prepaid access`,
  );
  assert.equal(body.get("metadata[bandup_tier]"), "ai");
});

test("bandup_payment_method names every wallet actually offered, joined the way a human reads a list", async () => {
  const body = await walletSession({}, { STRIPE_WALLET_METHODS: "alipay,wechat_pay" });
  assert.equal(body.get("metadata[bandup_payment_method]"), "Alipay or WeChat Pay");
});

test("with no wallet approved at all, the session is refused before Stripe is asked for one", async () => {
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.STRIPE_SECRET_KEY;
  const savedMethods = process.env.STRIPE_WALLET_METHODS;
  process.env.STRIPE_SECRET_KEY = "sk_test_wallet_checkout";
  // A name this catalogue does not recognise resolves to zero methods, the
  // same as if the variable were unset to an empty list.
  process.env.STRIPE_WALLET_METHODS = "paypal";
  let requested = false;
  globalThis.fetch = async () => {
    requested = true;
    return new Response(JSON.stringify({ url: "https://checkout.stripe.test/session" }), { status: 200 });
  };
  try {
    await assert.rejects(
      () =>
        stripe.createWalletCheckoutSession({
          plan: "tracking-monthly",
          userId: "11111111-1111-4111-8111-111111111111",
          email: null,
          customerId: null,
          successUrl: "https://bandup.life/billing",
          cancelUrl: "https://bandup.life/pricing",
        }),
      /no wallet payment methods are enabled/,
    );
    assert.equal(requested, false, "Stripe was asked for a Session with nothing sellable on it");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = savedKey;
    if (savedMethods === undefined) delete process.env.STRIPE_WALLET_METHODS;
    else process.env.STRIPE_WALLET_METHODS = savedMethods;
  }
});

test("createWalletCheckoutSession returns null when Stripe's session carries no usable url", async () => {
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_wallet_checkout";
  for (const responseBody of [{ url: "" }, {}]) {
    globalThis.fetch = async () => new Response(JSON.stringify(responseBody), { status: 200 });
    try {
      const url = await stripe.createWalletCheckoutSession({
        plan: "tracking-monthly",
        userId: "11111111-1111-4111-8111-111111111111",
        email: null,
        customerId: null,
        successUrl: "https://bandup.life/billing",
        cancelUrl: "https://bandup.life/pricing",
      });
      assert.equal(url, null, `${JSON.stringify(responseBody)} produced a url`);
    } finally {
      globalThis.fetch = savedFetch;
    }
  }
  if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = savedKey;
});

test("walletCurrency is the base currency and takes no second opinion", () => {
  for (const id of tiers.PLAN_IDS) {
    const plan = tiers.PLANS[id];
    assert.equal(tiers.walletCurrency(plan), plan.currency);
  }
  assert.equal(tiers.walletCurrency.length, 1, "a second argument means a currency can be asked for");
});

/*
  Neither the wallet nor the currency comes from the caller. A caller who could
  name the currency could name the price — a wallet line item is built by this
  app rather than read off a Stripe Price, so nothing downstream would catch
  it.
*/
test("the wallet route takes neither the wallet nor the currency from the request", () => {
  const source = readFileSync(
    join(process.cwd(), "app", "api", "billing", "wallet-checkout", "route.ts"),
    "utf8",
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  assert.doesNotMatch(code, /body[\s\S]{0,40}currency/, "the currency is read from the body");
  assert.doesNotMatch(code, /method: *"(alipay|wechat_pay)"/);
  assert.doesNotMatch(code, /currencyForCountry/, "the wallet currency is no longer per-visitor");
  assert.match(code, /createWalletCheckoutSession\(\{\s*plan,/);
});

test("the page names only the wallets the server says are available", () => {
  const source = readFileSync(join(process.cwd(), "app", "pricing", "PricingPlans.tsx"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  assert.match(code, /walletMethodList\(walletMethods\)/, "the button hard-codes its wallet names");
  assert.doesNotMatch(
    code,
    /Pay once with Alipay or WeChat Pay/,
    "a fixed label promises a wallet the account may not be approved for",
  );
  /*
    "do" or "does" depending on how many wallets are offered, so the phrase is
    split by an expression in the source. What must survive is the promise.
  */
  assert.match(code, /not renew/);

  const calls = code.match(/wallet-checkout/g) ?? [];
  assert.equal(calls.length, 1, `expected one wallet-checkout call, found ${calls.length}`);
});

/*
  A refusal must arrive with Stripe's reason attached.

  Stripe attaches `code` to errors about a thing (`api_key_expired`) and only a
  `message` to errors about a request — a parameter it will not accept, a
  payment method not enabled on the account. The log used to print the code
  alone, so the second kind arrived as "refused: 400", which says only that
  Stripe said no. That cost an hour of replaying calls by hand against the live
  account to find out what a log had already been told.
*/
test("a Stripe refusal carries its message into the error", async () => {
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_wallet_checkout";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: { type: "invalid_request_error", message: "The payment method type provided is invalid." },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  try {
    await assert.rejects(
      stripe.createWalletCheckoutSession({
        plan: "tracking-monthly",
        currency: "hkd",
        userId: "11111111-1111-4111-8111-111111111111",
        email: null,
        customerId: null,
        successUrl: "https://bandup.life/billing",
        cancelUrl: "https://bandup.life/pricing",
      }),
      (err) => {
        assert.match(
          String(err.message),
          /payment method type provided is invalid/,
          `the reason was thrown away: ${err.message}`,
        );
        // Message-only (no `code`): the classifier still has to be reachable,
        // and the error must still carry the status Stripe answered with —
        // not the constructor's null defaults, which is what an emptied
        // options object would silently fall back to.
        assert.equal(err.status, 400);
        assert.equal(err.code, null);
        assert.equal(err.fault, "platform");
        return true;
      },
    );
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = savedKey;
  }
});

/*
  `refusal`'s detail line has three shapes, depending on which of `code` and
  `message` Stripe actually sent — and the join between them, and the fallback
  when Stripe sends neither, are each their own way to get the log line wrong.
*/
test("a refusal's detail is exactly Stripe's code and message, joined only when both exist", async () => {
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_wallet_checkout";
  const attempt = async (status, error) => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error }), { status });
    try {
      await stripe.createPortalSession({ customerId: "cus_1", returnUrl: "https://bandup.life/billing" });
      throw new Error("expected a refusal");
    } catch (err) {
      return err;
    }
  };
  try {
    // Both present: joined with ": ", not concatenated bare and not dropped.
    const both = await attempt(402, { code: "card_declined", message: "Your card was declined." });
    assert.equal(both.message, "/billing_portal/sessions refused: card_declined: Your card was declined.");
    assert.equal(both.code, "card_declined");
    assert.equal(both.status, 402);
    assert.equal(both.fault, "learner", "card_declined is the payer's problem, not the owner's");

    // Code only: no trailing ": " left over from a message that isn't there.
    const codeOnly = await attempt(404, { code: "resource_missing" });
    assert.equal(codeOnly.message, "/billing_portal/sessions refused: resource_missing");

    // Message only: no leading ": " left over from a code that isn't there.
    const messageOnly = await attempt(400, { message: "Amount must be at least 1.00 hkd." });
    assert.equal(
      messageOnly.message,
      "/billing_portal/sessions refused: Amount must be at least 1.00 hkd.",
    );

    // Neither: falls back to the bare status rather than an empty detail.
    const neither = await attempt(500, {});
    assert.equal(neither.message, "/billing_portal/sessions refused: 500");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = savedKey;
  }
});

test("the prepaid migration is service-role-only and checks full refunds", () => {
  const source = readFileSync(
    join(process.cwd(), "supabase", "migrations", "0016_prepaid_wallet_access.sql"),
    "utf8",
  );
  assert.match(source, /apply_stripe_prepaid_purchase_event/);
  assert.match(source, /apply_stripe_prepaid_refund_event/);
  assert.match(source, /p_refund_amount <> coalesce/);
  assert.match(source, /from public, anon, authenticated/);
  assert.match(source, /to service_role/);
});
