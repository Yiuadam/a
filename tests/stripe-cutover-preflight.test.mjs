import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
register("../scripts/ts-resolve.mjs", import.meta.url);
const preflight = await import(`file://${join(ROOT, "scripts", "check-stripe-cutover-readiness.mjs")}`);
const workerPreflight = await import(
  pathToFileURL(join(ROOT, "lib", "cloudflare", "stripe-cutover-preflight.ts")).href,
);

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
  assert.deepEqual(
    workerPreflight.stripeBillingCutoverReport([sourceSubscription()], [sourceEvent()], [targetPurchase()]),
    report,
  );
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

test("string() rejects empty strings", () => {
  const evidence = workerPreflight.prepaidEvidenceFromProviderEvent({
    provider: "stripe",
    payload: {
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "payment",
          payment_status: "paid",
          payment_intent: "", // empty string
          amount_total: 499,
          metadata: { bandup_user_id: USER },
        },
      },
    },
  });
  assert.equal(evidence, null);
});

test("string() rejects non-strings", () => {
  const evidence = workerPreflight.prepaidEvidenceFromProviderEvent({
    provider: "stripe",
    payload: {
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "payment",
          payment_status: "paid",
          payment_intent: 123, // number, not string
          amount_total: 499,
          metadata: { bandup_user_id: USER },
        },
      },
    },
  });
  assert.equal(evidence, null);
});

test("object() rejects arrays and non-objects", () => {
  const evidence1 = workerPreflight.prepaidEvidenceFromProviderEvent({
    provider: "stripe",
    payload: ["array", "not", "object"],
  });
  assert.equal(evidence1, null);

  const evidence2 = workerPreflight.prepaidEvidenceFromProviderEvent({
    provider: "stripe",
    payload: "string_not_object",
  });
  assert.equal(evidence2, null);
});

test("positiveInteger() rejects zero and negative numbers", () => {
  // Zero amount should fail
  const zeroEvidence = workerPreflight.prepaidEvidenceFromProviderEvent({
    provider: "stripe",
    payload: {
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "payment",
          payment_status: "paid",
          payment_intent: "pi_test",
          amount_total: 0, // zero, not positive
          metadata: { bandup_user_id: USER },
        },
      },
    },
  });
  assert.equal(zeroEvidence, null);

  // Negative amount should fail
  const negEvidence = workerPreflight.prepaidEvidenceFromProviderEvent({
    provider: "stripe",
    payload: {
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "payment",
          payment_status: "paid",
          payment_intent: "pi_test",
          amount_total: -100,
          metadata: { bandup_user_id: USER },
        },
      },
    },
  });
  assert.equal(negEvidence, null);
});

test("only checkout.session.completed and async_payment_succeeded are accepted", () => {
  // Wrong type should fail
  const wrongType = workerPreflight.prepaidEvidenceFromProviderEvent({
    provider: "stripe",
    payload: {
      type: "charge.succeeded", // not accepted
      data: {
        object: {
          mode: "payment",
          payment_status: "paid",
          payment_intent: "pi_test",
          amount_total: 499,
          metadata: { bandup_user_id: USER },
        },
      },
    },
  });
  assert.equal(wrongType, null);

  // But async_payment_succeeded should work
  const asyncPayment = workerPreflight.prepaidEvidenceFromProviderEvent({
    provider: "stripe",
    payload: {
      type: "checkout.session.async_payment_succeeded",
      data: {
        object: {
          mode: "payment",
          payment_status: "paid",
          payment_intent: "pi_async",
          amount_total: 599,
          metadata: { bandup_user_id: USER },
        },
      },
    },
  });
  assert.ok(asyncPayment);
  assert.equal(asyncPayment.paymentIntentId, "pi_async");
});

test("wallet subscriptions must start with 'wallet:' prefix", () => {
  const report1 = workerPreflight.expectedStripePrepaidPurchases(
    [sourceSubscription({ external_price_id: "price_regular" })],
    [sourceEvent()],
  );
  assert.equal(report1.sourceWalletSubscriptions, 0);

  const report2 = workerPreflight.expectedStripePrepaidPurchases(
    [sourceSubscription({ external_price_id: "wallet:plus" })],
    [sourceEvent()],
  );
  assert.equal(report2.sourceWalletSubscriptions, 1);
  assert.equal(report2.expected.length, 1);
});

test("evidence with mismatched userId or amountMinor is tracked separately from unverifiable source", () => {
  // Two subscriptions, but only one has matching evidence
  const event = sourceEvent();
  const sub1 = sourceSubscription();
  const sub2 = sourceSubscription({ id: "sub2", external_subscription_id: "pi_other" });

  const report = workerPreflight.expectedStripePrepaidPurchases(
    [sub1, sub2],
    [event],
  );

  // One subscription has evidence, one doesn't
  assert.equal(report.sourceWalletSubscriptions, 2);
  assert.equal(report.sourcePaymentEvidence, 1);
  assert.equal(report.unverifiableSource, 1); // sub2 has no matching evidence
});

test("checkout mode and payment_status must both be correct", () => {
  const wrongMode = workerPreflight.prepaidEvidenceFromProviderEvent({
    provider: "stripe",
    payload: {
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "subscription", // should be "payment"
          payment_status: "paid",
          payment_intent: "pi_test",
          amount_total: 499,
          metadata: { bandup_user_id: USER },
        },
      },
    },
  });
  assert.equal(wrongMode, null);

  const wrongStatus = workerPreflight.prepaidEvidenceFromProviderEvent({
    provider: "stripe",
    payload: {
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "payment",
          payment_status: "unpaid", // should be "paid"
          payment_intent: "pi_test",
          amount_total: 499,
          metadata: { bandup_user_id: USER },
        },
      },
    },
  });
  assert.equal(wrongStatus, null);
});
