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
const {
  hkdPerUnit, minorPerUnit, toMajor, toMinor, currencyForCountry, countryFromRequest,
  walletTakes, ZERO_DECIMAL_CURRENCIES, WALLET_CURRENCIES,
} = currency;

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

  const yen = toMajor(amountIn(PLANS["ai-monthly"], "jpy"), "jpy");
  assert.ok(yen > 50 && yen < 5000, `ai-monthly is ¥${yen}, which is not a monthly price`);
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

/*
  Every non-euro country this catalogue names its own currency for, not only
  the two (Hong Kong, Great Britain) the test above already covers. Each of
  these is its own entry in the lookup table, so each has to be read back
  individually — a table that silently dropped "AU" would still pass a test
  that only ever asked about "HK".
*/
test("every named country resolves to the currency chosen for it, not the fallback", () => {
  const table = {
    US: "usd", AU: "aud", CA: "cad", SG: "sgd", JP: "jpy", IN: "inr", CN: "cny",
  };
  for (const [country, expected] of Object.entries(table)) {
    assert.equal(
      currencyForCountry(country),
      expected,
      `${country} should show ${expected}, not the US-dollar fallback`,
    );
  }
});

/*
  The euro area, in full — every member state this catalogue names, not only
  the two spot-checked above. Twenty-four countries share one currency, and
  each is its own array entry: dropping any single one silently sends that
  country's visitors to the dollar fallback instead of the euro they use.
*/
test("every euro-area country in the list is actually priced in euros", () => {
  const euroCountries = [
    "AD", "AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE",
    "IT", "LT", "LU", "LV", "MC", "MT", "NL", "PT", "SI", "SK", "SM", "VA",
  ];
  for (const country of euroCountries) {
    assert.equal(currencyForCountry(country), "eur", `${country} should be priced in euros`);
  }
});

/*
  Every currency Stripe counts in whole units, from the catalogue's own list —
  not only yen, which the test above already singles out. Each currency code
  is its own entry in the Set literal, so each has to be read back
  individually: a mutant that quietly dropped "krw" from the list would still
  pass a test that only ever asked about "jpy".
*/
test("every zero-decimal currency is read back out of the set, and minorPerUnit agrees", () => {
  const zeroDecimal = [
    "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf",
    "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
  ];
  for (const c of zeroDecimal) {
    assert.ok(ZERO_DECIMAL_CURRENCIES.has(c), `${c} should be zero-decimal`);
    assert.equal(minorPerUnit(c), 1, `${c} should count in whole units`);
  }
  // And a two-decimal currency is not caught by the same net.
  assert.ok(!ZERO_DECIMAL_CURRENCIES.has("hkd"));
  assert.equal(minorPerUnit("hkd"), 100);
});

/*
  toMinor multiplies; a mutant that divided instead would turn a HK$9 charge
  into nine cents, which is exactly the class of error the file's own header
  says is the worst kind (a hundredfold undercharge is survivable; this is not
  a hundredfold error but the same *direction* of harm to the business).
*/
test("toMinor scales up from a human amount to what Stripe stores", () => {
  assert.equal(toMinor(9, "usd"), 900);
  assert.equal(toMinor(4.9, "hkd"), 490);
  // Zero-decimal: minorPerUnit is 1, so the amount passes through unscaled.
  assert.equal(toMinor(100, "jpy"), 100);
});

/*
  The two mobile wallets, and the specific short list of currencies both will
  take — see the header comment above WALLET_CURRENCIES. Every entry is its
  own array element and its own StringLiteral mutant target; a test that only
  ever asked about one currency would leave the other eight unguarded, and an
  emptied array (WALLET_CURRENCIES -> []) would only be caught by asking about
  more than zero of them.
*/
test("a wallet payment can be presented in every currency the catalogue says it can", () => {
  for (const c of ["aud", "cad", "cny", "eur", "gbp", "hkd", "jpy", "sgd", "usd"]) {
    assert.ok(WALLET_CURRENCIES.has(c), `${c} should be a wallet currency`);
    assert.equal(walletTakes(c), true, `walletTakes(${c}) should be true`);
  }
  // The omission that matters: neither wallet takes rupees (see the header).
  assert.equal(walletTakes("inr"), false, "neither Alipay nor WeChat Pay takes INR");
  assert.ok(!WALLET_CURRENCIES.has("inr"));
});

test("walletTakes reads the currency case-insensitively", () => {
  // The set is stored lower-case; a caller passing what a Stripe object or an
  // upstream header handed back (which is not guaranteed to be lower-case)
  // must still be recognised.
  assert.equal(walletTakes("AUD"), true);
  assert.equal(walletTakes("Usd"), true);
});

/*
  The one header Cloudflare adds in front of every Worker request, and the one
  this app trusts precisely because a client cannot set it — see the header
  comment on countryFromRequest. Read through an actual Request/Headers pair
  rather than a hand-rolled stand-in, so the exact header name is what is
  under test.
*/
test("countryFromRequest reads Cloudflare's own header and nothing invented", () => {
  const withCountry = new Request("https://example.com/", {
    headers: { "cf-ipcountry": "HK" },
  });
  assert.equal(countryFromRequest(withCountry), "HK");

  const withoutCountry = new Request("https://example.com/");
  assert.equal(countryFromRequest(withoutCountry), null);
});
