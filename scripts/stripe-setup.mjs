#!/usr/bin/env node
/*
  Creates the Stripe products and prices this app sells, from this app's own
  catalogue, and prints the eight variables to paste into Cloudflare.

  ---------------------------------------------------------------------------
  Why this exists rather than a page of dashboard instructions

  Six prices have to be typed by hand into six forms, and every one of them is
  an amount that must match lib/billing/tiers.ts exactly. If they do not match,
  Stripe wins — Stripe is what actually charges the card — so a mistyped digit
  charges a subscriber an amount the pricing page never showed them. That is the
  one failure in this whole integration that costs somebody money and cannot be
  fixed by a deploy.

  So the amounts are not typed. They are read out of the catalogue the pricing
  page reads, and sent to Stripe as they are.

  ---------------------------------------------------------------------------
  Running it

      STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs --dry-run
      STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs

  Use a test key first (sk_test_…). Everything it makes in test mode is
  disposable, and Stripe's test card 4242 4242 4242 4242 will take you through
  a real checkout against it. Only then run it again with the live key.

  It is safe to run twice. Products and prices are looked up by a stable key
  before anything is created, so a second run reports what already exists
  instead of making a duplicate.

  ---------------------------------------------------------------------------
  What it will not do

  It does not create the webhook endpoint, because that needs a URL and a
  signing secret that only ever appears once, in the dashboard — see DEPLOY.md.
  It does not write any secret anywhere: it prints them, and where they go is a
  decision for the person running it.
*/
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/*
  The catalogue imports through the `@/…` alias, which Node knows nothing
  about. tests/alias-resolve.mjs is the hook that teaches it, and it is reused
  here rather than copied so there is one answer to how a .ts file in this
  repository gets loaded outside Next.
*/
register("../tests/alias-resolve.mjs", import.meta.url);

const tiers = await import(pathToFileURL(join(process.cwd(), "lib", "billing", "tiers.ts")).href);
const { PLANS, PLAN_IDS, TIERS, formatPrice } = tiers;

const DRY = process.argv.includes("--dry-run");

/*
  Where to write the six ids so they can be uploaded rather than retyped.

  Six ids pasted into six dashboard fields is six chances to put Pro's id in
  Standard's slot, which sells the expensive plan at the cheap price. The
  checkout guard refuses that sale rather than charging wrongly, so it is
  survivable — but not making the mistake is better than catching it, and the
  file below is in exactly the KEY=VALUE shape `wrangler secret bulk` reads.
*/
const OUT_FLAG = process.argv.indexOf("--out");
const OUT = OUT_FLAG === -1 ? null : (process.argv[OUT_FLAG + 1] ?? "stripe-prices.env");
const KEY = process.env.STRIPE_SECRET_KEY;

if (!KEY) {
  console.error(
    "\nSTRIPE_SECRET_KEY is not set.\n\n" +
      "  Stripe dashboard -> Developers -> API keys -> Secret key.\n" +
      "  Start with the test one, which begins sk_test_.\n\n" +
      "  STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs --dry-run\n",
  );
  process.exit(1);
}

const LIVE = KEY.startsWith("sk_live_");
const API = "https://api.stripe.com/v1";

/** Stripe takes form-encoded bodies, including for nested keys like recurring[interval]. */
function form(params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    body.set(key, String(value));
  }
  return body;
}

async function stripe(method, path, params) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params ? form(params) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${json?.error?.message ?? "unknown error"}`);
  }
  return json;
}

/** One product per tier, found by a stable key rather than by its name. */
async function productFor(tier) {
  const key = `bandup-${tier}`;
  const found = await stripe(
    "GET",
    `/products/search?query=${encodeURIComponent(`metadata['bandup_tier']:'${tier}'`)}`,
  );
  if (found.data?.length) return { product: found.data[0], created: false };

  const definition = TIERS[tier];
  if (DRY) return { product: { id: `(would create ${key})` }, created: true };
  const product = await stripe("POST", "/products", {
    name: `BandUp ${definition.name}`,
    description: definition.blurb,
    "metadata[bandup_tier]": tier,
  });
  return { product, created: true };
}

/**
 * One price per plan, keyed by the plan id.
 *
 * A Stripe price is immutable: re-pricing means creating a new one. The lookup
 * key is what makes that survivable — `transfer_lookup_key` moves the name from
 * the old price to the new one, so the old price keeps working for everybody
 * already subscribed to it while every new checkout gets the new amount. That
 * is the behaviour you want and it is the opposite of what deleting and
 * recreating would do.
 */
async function priceFor(planId, productId) {
  const plan = PLANS[planId];
  /*
    `expand[]=data.currency_options` for the same reason lib/billing/stripe.ts
    expands it: Stripe does not return regional prices on a Price unless asked,
    so without this every existing Price looks like it has none and the script
    offers to recreate one that is already correct.
  */
  const existing = await stripe(
    "GET",
    `/prices?lookup_keys[]=${encodeURIComponent(planId)}&active=true&expand[]=data.currency_options`,
  );
  const match = existing.data?.[0];

  /*
    A Price is correct only if every currency on it is correct. Checking the
    base amount alone would leave a Price created before regional pricing in
    place, still charging a Londoner in Hong Kong dollars while the page quotes
    pounds — which is the mismatch the whole catalogue exists to prevent.
  */
  const currenciesMatch = () => {
    if (match.unit_amount !== plan.amountMinor) return false;
    if (match.currency !== plan.currency) return false;
    const opts = match.currency_options ?? {};
    for (const [code, amount] of Object.entries(plan.prices)) {
      if (code === plan.currency) continue;
      if (opts[code]?.unit_amount !== amount) return false;
    }
    return true;
  };

  if (match && currenciesMatch()) {
    return { price: match, state: "already correct" };
  }
  if (DRY) {
    return {
      price: { id: "(would create)" },
      state: match ? `would re-price from ${formatPrice(match.unit_amount, match.currency)}` : "would create",
    };
  }
  /*
    One Price, many currencies. `currency_options` is what lets a single Price
    id charge a Londoner in pounds and a Tokyo candidate in yen — Checkout picks
    by the customer's address, and anything not named here Stripe converts from
    the base amount. It is why regional pricing needs no second Price and no
    second environment variable.
  */
  const currencyOptions = {};
  for (const [code, amount] of Object.entries(plan.prices)) {
    if (code === plan.currency) continue;
    currencyOptions[`currency_options[${code}][unit_amount]`] = amount;
  }

  const price = await stripe("POST", "/prices", {
    product: productId,
    unit_amount: plan.amountMinor,
    currency: plan.currency,
    "recurring[interval]": plan.interval,
    lookup_key: planId,
    transfer_lookup_key: match ? "true" : undefined,
    ...currencyOptions,
  });
  return { price, state: match ? "re-priced" : "created" };
}

const VAR = {
  "standard-monthly": "STRIPE_PRICE_STANDARD_MONTHLY",
  "standard-yearly": "STRIPE_PRICE_STANDARD_YEARLY",
  "plus-monthly": "STRIPE_PRICE_PLUS_MONTHLY",
  "plus-yearly": "STRIPE_PRICE_PLUS_YEARLY",
  "pro-monthly": "STRIPE_PRICE_PRO_MONTHLY",
  "pro-yearly": "STRIPE_PRICE_PRO_YEARLY",
};

console.log(
  `\n${DRY ? "Dry run" : "Creating products and prices"} in ${
    LIVE ? "LIVE mode — these will charge real cards" : "test mode"
  }.${DRY ? " Nothing will be created." : ""}\n`,
);

const lines = [];
const seen = new Map();

/*
  Anything Stripe refuses is reported as the sentence Stripe wrote and nothing
  else. A stack trace here helps nobody: the two things that actually go wrong
  are a key from the wrong mode and a key that has been rolled, and both say so
  plainly in the message.
*/
try {
for (const planId of PLAN_IDS) {
  const plan = PLANS[planId];
  if (!seen.has(plan.tier)) {
    const { product, created } = await productFor(plan.tier);
    seen.set(plan.tier, product.id);
    console.log(`  ${TIERS[plan.tier].name.padEnd(9)} product ${product.id}${created ? "  (new)" : "  (existing)"}`);
  }
  const { price, state } = await priceFor(planId, seen.get(plan.tier));
  console.log(
    `    ${planId.padEnd(18)} ${formatPrice(plan.amountMinor, plan.currency).padStart(8)} / ${
      plan.interval
    }   ${price.id.padEnd(32)} ${state}`,
  );
  lines.push(`${VAR[planId]}=${price.id}`);
}
} catch (err) {
  console.error(`\nStripe refused the request:\n  ${err instanceof Error ? err.message : String(err)}\n`);
  console.error(
    "  If it mentions an invalid API key, check you copied the whole thing and that\n" +
      "  it is the secret key (sk_...) rather than the publishable one (pk_...).\n",
  );
  process.exit(1);
}

console.log(`\n${DRY ? "Nothing was created." : "Done."} The six ids:\n`);
for (const line of lines) console.log(`  ${line}`);

if (OUT && !DRY) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  console.log(
    `\nWritten to ${OUT}. Upload all six in one go, without retyping any of them:\n\n` +
      `  npx wrangler secret bulk ${OUT}\n\n` +
      "Then delete the file — it is not secret, but it is clutter that looks like\n" +
      "configuration and will be out of date the next time a price moves.\n",
  );
} else {
  console.log(
    "\nPut them into Cloudflare -> Workers & Pages -> bandup -> Settings ->\n" +
      "Variables and Secrets. Or re-run with `--out stripe-prices.env` to get a\n" +
      "file you can upload with `npx wrangler secret bulk` instead of retyping.\n",
  );
}
console.log(
  "\nStill to do by hand, because neither can be scripted safely:\n" +
    "  STRIPE_SECRET_KEY      the key you just used\n" +
    "  STRIPE_WEBHOOK_SECRET  from Developers -> Webhooks -> Add endpoint\n" +
    "                         URL:    https://bandup.life/api/billing/webhook/stripe\n" +
    "                         Events: customer.subscription.created, .updated, .deleted\n",
);
