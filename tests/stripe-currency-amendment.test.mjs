/*
  Adding a currency must amend the Prices that exist, not replace them.

  The distinction is worth a test because both behaviours look identical in the
  script's output and only one of them is safe. A Stripe Price is immutable in
  its `unit_amount`, so the reflex when anything about a price changes is to
  create a new one and move the lookup key across. Do that for a currency and
  six new price ids fall out — which means six STRIPE_PRICE_* values to upload
  to Cloudflare, and a live site whose checkout guard refuses every sale in the
  minutes between Stripe having the new ids and the Worker having them.

  `currency_options` is not immutable. Patching it onto the existing Price
  changes nothing the deployment knows about, and the subscribers on that Price
  keep the amount and the currency they signed up at.

  So this runs the real script against a fake Stripe and reads the request log:
  POST /prices/{id} is an amendment, POST /prices is a replacement.
*/
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const tiers = await import(
  pathToFileURL(join(process.cwd(), "lib", "billing", "tiers.ts")).href
);
const { PLANS, PLAN_IDS } = tiers;

/**
 * Six Prices as Stripe would return them, priced in everything the catalogue
 * names except `missing` — which is the state the account is in between a
 * currency being added to the catalogue and this script being run.
 */
function account(missing, overrides = {}) {
  const prices = {};
  for (const id of PLAN_IDS) {
    const plan = PLANS[id];
    const currency_options = {};
    for (const [code, amount] of Object.entries(plan.prices)) {
      if (code === plan.currency || code === missing) continue;
      currency_options[code] = { unit_amount: amount };
    }
    prices[id] = {
      id: `price_${id}`,
      unit_amount: plan.amountMinor,
      currency: plan.currency,
      currency_options,
      ...(overrides[id] ?? {}),
    };
  }
  return { prices };
}

function run(state) {
  const dir = mkdtempSync(join(tmpdir(), "fake-stripe-"));
  const log = join(dir, "requests.log");
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "./tests/fake-stripe.mjs", "scripts/stripe-setup.mjs"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          STRIPE_SECRET_KEY: "sk_test_fake",
          FAKE_STRIPE: JSON.stringify(state),
          FAKE_STRIPE_LOG: log,
        },
      },
    );
    return { stdout, requests: readFileSync(log, "utf8").trim().split("\n") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a currency the Prices lack is added to them in place", () => {
  const { stdout, requests } = run(account("cny"));

  const amended = requests.filter((r) => /^POST \/prices\/price_/.test(r));
  assert.equal(
    amended.length,
    PLAN_IDS.length,
    `expected all ${PLAN_IDS.length} Prices to be amended, saw:\n  ${requests.join("\n  ")}`,
  );
  assert.equal(
    requests.filter((r) => r === "POST /prices").length,
    0,
    "a new Price was created — the six ids have moved and the deployment does not know",
  );

  for (const id of PLAN_IDS) {
    assert.match(stdout, new RegExp(`${id}[^\\n]*price_${id}[^\\n]*added cny`));
  }
  assert.match(stdout, /same six ids as before/);
});

test("a base amount that has actually changed still makes a new Price", () => {
  const { stdout, requests } = run(
    account("cny", { "pro-yearly": { unit_amount: PLANS["pro-yearly"].amountMinor - 100 } }),
  );

  assert.equal(
    requests.filter((r) => r === "POST /prices").length,
    1,
    "re-pricing has to create a Price, because unit_amount is the one field Stripe will not edit",
  );
  assert.match(stdout, /pro-yearly[^\n]*price_new_pro-yearly[^\n]*re-priced/);
  /* And the other five are still amended rather than dragged along with it. */
  assert.equal(requests.filter((r) => /^POST \/prices\/price_/.test(r)).length, PLAN_IDS.length - 1);
  assert.doesNotMatch(stdout, /same six ids as before/);
});

test("a run with nothing to do posts nothing at all", () => {
  const { stdout, requests } = run(account(null));

  assert.equal(
    requests.filter((r) => r.startsWith("POST")).length,
    0,
    "an already-correct account was written to anyway",
  );
  assert.match(stdout, /already correct/);
});
