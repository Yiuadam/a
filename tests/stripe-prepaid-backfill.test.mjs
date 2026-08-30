import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = process.cwd();
const backfill = await import(`file://${join(ROOT, "scripts", "backfill-stripe-prepaid-purchases.mjs")}`);

const USER = "70000000-0000-4000-8000-000000000001";
const SUBSCRIPTION = "80000000-0000-4000-8000-000000000001";
const subscription = {
  id: SUBSCRIPTION,
  user_id: USER,
  provider: "stripe",
  external_price_id: "wallet:plus-monthly",
  external_subscription_id: "pi_wallet_1",
};
const event = {
  provider: "stripe",
  payload: {
    type: "checkout.session.completed",
    data: { object: {
      mode: "payment",
      payment_status: "paid",
      payment_intent: "pi_wallet_1",
      amount_total: 499,
      metadata: { bandup_user_id: USER },
    } },
  },
};
const purchase = {
  payment_intent_id: "pi_wallet_1",
  user_id: USER,
  subscription_id: SUBSCRIPTION,
  amount_minor: 499,
};

test("prepaid backfill permits only verified missing original-payment rows", () => {
  const missing = backfill.backfillDecision([subscription], [event], []);
  assert.equal(missing.canApply, true);
  assert.equal(missing.missing.length, 1);
  assert.equal(missing.report.ready, false);

  const exact = backfill.backfillDecision([subscription], [event], [purchase]);
  assert.equal(exact.canApply, true);
  assert.equal(exact.missing.length, 0);
  assert.equal(exact.report.ready, true);

  const wrong = backfill.backfillDecision([subscription], [event], [{ ...purchase, amount_minor: 500 }]);
  assert.equal(wrong.canApply, false);
  assert.equal(wrong.missing.length, 0);
});

test("backfill has an explicit apply switch and hides all identifiers from output", () => {
  const source = readFileSync(join(ROOT, "scripts", "backfill-stripe-prepaid-purchases.mjs"), "utf8");
  assert.match(source, /mode: apply \? "apply" : "dry-run"/);
  assert.match(source, /--apply/);
  assert.match(source, /BEGIN IMMEDIATE;/);
  assert.match(source, /verification: finalReport/);
  assert.doesNotMatch(source, /paymentIntentId[^\n]{0,80}JSON\.stringify/);
  assert.doesNotMatch(source, /userId[^\n]{0,80}JSON\.stringify/);
});
