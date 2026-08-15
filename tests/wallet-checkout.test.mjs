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
async function walletSession(args) {
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.STRIPE_SECRET_KEY;
  const requests = [];
  process.env.STRIPE_SECRET_KEY = "sk_test_wallet_checkout";
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
  }
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.stripe.com/v1/checkout/sessions");
  return new URLSearchParams(requests[0].init.body);
}

/*
  One Session, both wallets.

  It used to be one Session per wallet, which is why the page carried two
  buttons and asked somebody to choose a wallet before they had left it. A
  Session may list both; Checkout then offers the choice on its own page, where
  the buyer can actually see them. The page went from three payment buttons to
  two, which is what brought them above the fold on a laptop.
*/
test("one wallet session offers Alipay and WeChat Pay together", async () => {
  const body = await walletSession({ currency: "hkd" });

  assert.equal(body.get("mode"), "payment");
  assert.equal(body.get("managed_payments[enabled]"), "false");

  const methods = [body.get("payment_method_types[0]"), body.get("payment_method_types[1]")];
  assert.deepEqual([...methods].sort(), ["alipay", "wechat_pay"]);
  assert.equal(body.get("payment_method_types[2]"), null, "a third method appeared");

  /*
    Mandatory whenever wechat_pay is on the Session — its absence 400s every
    one of them before the buyer sees anything. It is no longer conditional,
    because WeChat Pay is no longer conditional.
  */
  assert.equal(body.get("payment_method_options[wechat_pay][client]"), "web");

  assert.equal(body.get("line_items[0][price_data][currency]"), "hkd");
  assert.equal(body.get("line_items[0][price_data][unit_amount]"), "1290");
  assert.equal(body.get("metadata[bandup_plan_id]"), "plus-monthly");
  assert.equal(body.get("payment_intent_data[metadata][bandup_plan_id]"), "plus-monthly");
  assert.equal(body.get("customer_creation"), "always");
});

/*
  A wallet line item is built by this app rather than read off a Stripe Price,
  so the currency is a choice — and a wrong choice is a Session Stripe refuses
  after the buyer has committed to paying.
*/
test("the wallet charges in the reader's currency where both wallets take it", async () => {
  const body = await walletSession({ currency: "gbp" });
  assert.equal(body.get("line_items[0][price_data][currency]"), "gbp");
  assert.equal(
    body.get("line_items[0][price_data][unit_amount]"),
    String(tiers.PLANS["plus-monthly"].prices.gbp),
    "the wallet quoted one amount and charged another",
  );
});

test("a currency neither wallet accepts falls back to the base one", async () => {
  /* Alipay and WeChat Pay both refuse INR. The catalogue prices in it anyway. */
  assert.equal(tiers.PRICED_CURRENCIES.includes("inr"), true);
  assert.equal(currency.walletTakes("inr"), false);

  const body = await walletSession({ currency: "inr" });
  assert.equal(body.get("line_items[0][price_data][currency]"), "hkd");
  assert.equal(body.get("line_items[0][price_data][unit_amount]"), "1290");
});

test("walletCurrency refuses anything the catalogue has not priced", () => {
  const plan = tiers.PLANS["plus-monthly"];
  assert.equal(tiers.walletCurrency(plan, "gbp"), "gbp");
  assert.equal(tiers.walletCurrency(plan, "GBP"), "gbp");
  /* Priced, but no wallet takes it. */
  assert.equal(tiers.walletCurrency(plan, "inr"), "hkd");
  /* A wallet takes it, but nobody chose a price in it. */
  assert.equal(tiers.walletCurrency(plan, "chf"), "hkd");
  /* Not a currency at all. */
  assert.equal(tiers.walletCurrency(plan, "zzz"), "hkd");
});

/*
  The currency must come from the address Cloudflare resolved, never from the
  request body. A caller who can name the currency can name the price — ask for
  the cheapest one in the catalogue and pay that — and unlike a subscription
  there is no Stripe Price downstream for the checkout guard to check it
  against.
*/
test("the wallet route derives the currency from the request, not the body", () => {
  const source = readFileSync(
    join(process.cwd(), "app", "api", "billing", "wallet-checkout", "route.ts"),
    "utf8",
  );
  assert.match(source, /currencyForCountry\(countryFromRequest\(req\)\)/);
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(
    code,
    /body[\s\S]{0,40}currency/,
    "the currency is being read out of the request body",
  );
});

test("pricing offers one wallet button naming both, and says it does not renew", () => {
  const source = readFileSync(join(process.cwd(), "app", "pricing", "PricingPlans.tsx"), "utf8");
  assert.match(source, /Alipay or WeChat Pay/);
  assert.match(source, /do not renew/);

  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  /* One button, so exactly one call, and it names no method. */
  const calls = code.match(/wallet-checkout/g) ?? [];
  assert.equal(calls.length, 1, `expected one wallet-checkout call, found ${calls.length}`);
  assert.doesNotMatch(code, /method: "(alipay|wechat_pay)"/);
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
