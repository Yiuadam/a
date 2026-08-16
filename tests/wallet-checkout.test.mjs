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
      plan: "plus-monthly",
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
  const plan = tiers.PLANS["plus-monthly"];

  assert.equal(body.get("line_items[0][price_data][currency]"), plan.currency);
  assert.equal(body.get("line_items[0][price_data][unit_amount]"), String(plan.amountMinor));
  assert.equal(body.get("metadata[bandup_plan_id]"), "plus-monthly");
  assert.equal(body.get("customer_creation"), "always");
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
        plan: "plus-monthly",
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
        return true;
      },
    );
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
