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

test("wallet checkout sends an exact prepaid plan to each supported method", async () => {
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
    for (const method of ["wechat_pay", "alipay"]) {
      const url = await stripe.createWalletCheckoutSession({
        plan: "plus-monthly",
        method,
        userId: "11111111-1111-4111-8111-111111111111",
        email: "learner@example.test",
        customerId: null,
        successUrl: "https://bandup.life/billing?checkout=done",
        cancelUrl: "https://bandup.life/pricing?checkout=cancelled",
      });
      assert.equal(url, "https://checkout.stripe.test/session");
    }
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = savedKey;
  }

  assert.equal(requests.length, 2);
  for (const [index, request] of requests.entries()) {
    const body = new URLSearchParams(request.init.body);
    assert.equal(request.url, "https://api.stripe.com/v1/checkout/sessions");
    assert.equal(body.get("mode"), "payment");
    assert.equal(body.get("managed_payments[enabled]"), "false");
    assert.equal(body.get("payment_method_types[0]"), index === 0 ? "wechat_pay" : "alipay");
    assert.equal(body.get("line_items[0][price_data][currency]"), "hkd");
    assert.equal(body.get("line_items[0][price_data][unit_amount]"), "1290");
    assert.equal(body.get("metadata[bandup_plan_id]"), "plus-monthly");
    assert.equal(body.get("payment_intent_data[metadata][bandup_plan_id]"), "plus-monthly");
    assert.equal(body.get("customer_creation"), "always");
  }
});

test("pricing offers both wallets and states that the pass does not renew", () => {
  const source = readFileSync(join(process.cwd(), "app", "pricing", "PricingPlans.tsx"), "utf8");
  assert.match(source, /method: "wechat_pay"/);
  assert.match(source, /method: "alipay"/);
  assert.match(source, /WeChat Pay/);
  assert.match(source, /Alipay/);
  assert.match(source, /does not renew\s+automatically/);
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
