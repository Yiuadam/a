import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = process.cwd();
const preflight = await import(`file://${join(ROOT, "scripts", "check-stripe-cutover-readiness.mjs")}`);

const USER = "70000000-0000-4000-8000-000000000001";
const SUBSCRIPTION = "80000000-0000-4000-8000-000000000001";

function sourceSubscription(overrides = {}) {
  return {
    id: SUBSCRIPTION,
    user_id: USER,
    provider: "stripe",
    external_price_id: "wallet:plus-monthly",
    external_subscription_id: "pi_wallet_1",
    ...overrides,
  };
}

function sourceEvent(overrides = {}) {
  return {
    provider: "stripe",
    payload: {
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "payment",
          payment_status: "paid",
          payment_intent: "pi_wallet_1",
          amount_total: 499,
          metadata: { bandup_user_id: USER },
        },
      },
    },
    ...overrides,
  };
}

function targetPurchase(overrides = {}) {
  return {
    payment_intent_id: "pi_wallet_1",
    user_id: USER,
    subscription_id: SUBSCRIPTION,
    amount_minor: 499,
    ...overrides,
  };
}

test("the payment preflight accepts only exact original-payment evidence", () => {
  const report = preflight.stripeBillingCutoverReport(
    [sourceSubscription()],
    [sourceEvent()],
    [targetPurchase()],
  );
  assert.equal(report.ready, true);
  assert.equal(report.expectedPrepaidPurchases, 1);
});

test("missing or partial legacy evidence fails closed before a native payment flip", () => {
  const noEvidence = preflight.stripeBillingCutoverReport([sourceSubscription()], [], []);
  assert.equal(noEvidence.ready, false);
  assert.equal(noEvidence.unverifiableSource, 1);

  const partialEvent = sourceEvent();
  delete partialEvent.payload.data.object.amount_total;
  const partial = preflight.stripeBillingCutoverReport(
    [sourceSubscription()],
    [partialEvent],
    [],
  );
  assert.equal(partial.ready, false);
  assert.equal(partial.unverifiableSource, 1);
});

test("the payment preflight catches a wrong amount, user, subscription or unexpected ledger row", () => {
  for (const target of [
    targetPurchase({ amount_minor: 500 }),
    targetPurchase({ user_id: "70000000-0000-4000-8000-000000000002" }),
    targetPurchase({ subscription_id: "80000000-0000-4000-8000-000000000002" }),
  ]) {
    const report = preflight.stripeBillingCutoverReport([sourceSubscription()], [sourceEvent()], [target]);
    assert.equal(report.ready, false);
    assert.equal(report.mismatchedTarget, 1);
  }
  const extra = preflight.stripeBillingCutoverReport(
    [sourceSubscription()], [sourceEvent()],
    [targetPurchase(), targetPurchase({ payment_intent_id: "pi_extra" })],
  );
  assert.equal(extra.ready, false);
  assert.equal(extra.unexpectedTarget, 1);
});

test("the payment preflight is a read-only tool that does not print account or payment identifiers", () => {
  const source = readFileSync(join(ROOT, "scripts", "check-stripe-cutover-readiness.mjs"), "utf8");
  const body = source.slice(source.indexOf("async function main()"));
  assert.match(source, /Read-only evidence/);
  assert.match(source, /--command", "SELECT payment_intent_id/);
  assert.doesNotMatch(body, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/);
  assert.match(source, /JSON\.stringify\(\{ target: production/);
  assert.doesNotMatch(source, /paymentIntentId[^\n]{0,40}JSON\.stringify/);
});
