/*
  A price is right in every currency, or it is not right.

  Regional pricing looks like a presentation problem and is an arithmetic one.
  The cost of serving a subscriber is the same wherever they live — an essay
  marked in Dhaka costs exactly what an essay marked in Sydney costs — so a
  price chosen for one country has to clear the same floor as a price chosen
  for another. Two things can go wrong and neither shows up on screen:

  A price below Stripe's minimum charge is simply refused. Stripe will not take
  less than about US$0.50, and the first draft of this catalogue priced Standard
  at $0.49 and HK$3.90 — both unchargeable, both looking perfectly fine on the
  pricing page.

  A price below cost sells at a loss, quietly, one subscriber at a time. The
  first draft of the regional table discounted India by about a fifth on the
  instinct that a lower-income market should pay less. Four of its six plans
  went underwater, because on the AI tiers the model cost is 80-95% of the
  price and there is nothing to discount. This test found all four.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const load = (...p) => import(pathToFileURL(join(process.cwd(), ...p)).href);
const tiers = await load("lib", "billing", "tiers.ts");
const currency = await load("lib", "billing", "currency.ts");
const models = await load("lib", "ai", "models.ts");

const {
  MIN_MONTHLY_MARGIN_HKD, MONTHLY_AI_CAPS, PLANS, PLAN_IDS,
  PRICED_CURRENCIES, HKD_PER_USD, amountIn, netRevenue,
} = tiers;
const { hkdPerUnit, minorPerUnit, toMajor, currencyForCountry, ZERO_DECIMAL_CURRENCIES } = currency;

/*
  Stripe refuses a charge under roughly US$0.50. The published figures per
  currency, for the ones this catalogue prices.
*/
const STRIPE_MINIMUM = {
  hkd: 4.0, usd: 0.5, eur: 0.5, gbp: 0.3, aud: 0.5,
  cad: 0.5, sgd: 0.5, jpy: 50, inr: 50,
  /*
    Stripe publishes no minimum for CNY — it is a wallet currency rather than
    one of the card presentment currencies the table covers. 4.00 is the US$0.50
    floor converted and rounded up, which is the conservative reading: if the
    real minimum is lower this test is merely strict, and if it is higher the
    cheapest plan here (¥4.90) still clears it.
  */
  cny: 4.0,
};

/** Worst-case AI cost of one month of a tier, in Hong Kong dollars. */
function monthlyAiHkd(tier) {
  const usd = models.COSTED_ROUTES.reduce(
    (total, route) => total + (MONTHLY_AI_CAPS[tier][route] ?? 0) * models.worstCaseCost(route),
    0,
  );
  return usd * HKD_PER_USD;
}

test("every currency in the catalogue has a rate to check it against", () => {
  for (const c of PRICED_CURRENCIES) {
    assert.ok(hkdPerUnit(c) > 0, `${c} has no rate — its prices cannot be checked`);
  }
});

test("every plan is priced in every currency the catalogue claims", () => {
  for (const id of PLAN_IDS) {
    for (const c of PRICED_CURRENCIES) {
      assert.equal(
        typeof PLANS[id].prices[c],
        "number",
        `${id} has no price in ${c}, so it would silently fall back to the base amount`,
      );
    }
  }
});

test("no price is below what Stripe will accept", () => {
  for (const id of PLAN_IDS) {
    for (const c of PRICED_CURRENCIES) {
      const major = toMajor(amountIn(PLANS[id], c), c);
      const min = STRIPE_MINIMUM[c];
      assert.ok(min !== undefined, `no published Stripe minimum recorded for ${c}`);
      assert.ok(
        major >= min,
        `${id} in ${c} is ${major}, under Stripe's ${min} minimum — the charge would be refused`,
      );
    }
  }
});

test("every price clears the margin floor at full AI usage", () => {
  const failures = [];
  for (const id of PLAN_IDS) {
    const plan = PLANS[id];
    const months = plan.interval === "year" ? 12 : 1;
    const ai = monthlyAiHkd(plan.tier) * months;

    for (const c of PRICED_CURRENCIES) {
      const perMonth = (netRevenue(plan, c) - ai) / months;
      if (perMonth < MIN_MONTHLY_MARGIN_HKD) {
        failures.push(`${id} in ${c}: HK$${perMonth.toFixed(2)}/mo`);
      }
    }
  }
  assert.deepEqual(
    failures,
    [],
    `these prices do not clear HK$${MIN_MONTHLY_MARGIN_HKD} a month at full usage:\n  ` +
      failures.join("\n  "),
  );
});

/*
  Zero-decimal currencies are the hundredfold trap. Stripe stores ¥100 as 100,
  not 10000, so a catalogue that wrote yen in "cents" would charge a hundred
  times the intended price — the one direction of error that ends in a
  chargeback rather than a shrug.
*/
test("yen is written in whole yen", () => {
  assert.equal(minorPerUnit("jpy"), 1);
  assert.equal(minorPerUnit("hkd"), 100);
  assert.ok(ZERO_DECIMAL_CURRENCIES.has("jpy"));

  const yen = toMajor(amountIn(PLANS["plus-monthly"], "jpy"), "jpy");
  assert.ok(yen > 50 && yen < 5000, `plus-monthly is ¥${yen}, which is not a monthly price`);
});

test("a visitor is shown a currency somebody chose, or dollars", () => {
  assert.equal(currencyForCountry("HK"), "hkd");
  assert.equal(currencyForCountry("gb"), "gbp");
  assert.equal(currencyForCountry("DE"), "eur");
  assert.equal(currencyForCountry("IE"), "eur");
  /* In the union, not in the euro. */
  assert.equal(currencyForCountry("SE"), "usd");
  /* Unlisted, unknown, and Cloudflare's own placeholders. */
  assert.equal(currencyForCountry("VN"), "usd");
  assert.equal(currencyForCountry("XX"), "usd");
  assert.equal(currencyForCountry(null), "usd");
});
