/*
  Reads the four live Prices back from Stripe and says, per plan, whether each
  one matches lib/billing/tiers.ts — using the same comparison
  /api/billing/health runs (priceCatalogueFault), so the sentence it prints
  is the one the health check is withholding from a public caller.

  Read-only: nothing is created or changed. Run from the repo root:

    STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-check.mjs
*/
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

register("../tests/alias-resolve.mjs", import.meta.url);

const { PLAN_IDS } = await import(pathToFileURL(join(process.cwd(), "lib", "billing", "tiers.ts")).href);
const { priceCatalogueFault } = await import(pathToFileURL(join(process.cwd(), "lib", "billing", "stripe.ts")).href);

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
  console.error("STRIPE_SECRET_KEY is not set.");
  process.exit(2);
}

async function stripeGet(path) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${body?.error?.message ?? "unknown error"}`);
  return body;
}

let faults = 0;
for (const plan of PLAN_IDS) {
  const list = await stripeGet(
    `/prices?lookup_keys[]=${encodeURIComponent(plan)}&active=true&expand[]=data.currency_options`,
  );
  const price = list.data?.[0];
  if (!price) {
    console.log(`${plan.padEnd(16)} NO active Price carries lookup_key ${plan}`);
    faults += 1;
    continue;
  }
  const fault = priceCatalogueFault(plan, price.id, price);
  const options = Object.keys(price.currency_options ?? {}).sort().join(",");
  console.log(`${plan.padEnd(16)} ${price.id}  ${fault ?? "matches the catalogue"}`);
  console.log(`${"".padEnd(16)} currencies on the Price: ${price.currency}${options ? `, ${options}` : " (no currency_options)"}`);
  if (fault) faults += 1;
}
process.exit(faults === 0 ? 0 : 1);
