import { accountsEnabled } from "@/lib/auth/env";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { stripeSecretKey, stripePriceId } from "./env";
import { stripeDiagnostic, verifyCataloguePrices } from "./stripe";
import { PLAN_IDS } from "./tiers";

/*
  Whether billing is actually wired end to end, as a fixed set of booleans.

  ---------------------------------------------------------------------------
  Why this exists, and why it is not app/api/account/diagnostics/route.ts

  That route answers "what is wrong, in detail" and only an admin session may
  ask it. This answers "is anything wrong at all", and anyone may ask it —
  which is what makes it useful the way DEPLOY.md needs it used: a step in
  .github/workflows/deploy-cloudflare.yml that runs after every deploy, with no
  session to authenticate, and fails the workflow the moment billing configura-
  tion goes missing for any reason — a variable deleted by hand in the
  dashboard, a key rotated badly, a Stripe Price archived — rather than waiting
  for a user to notice their subscription stopped working.

  So the two share the primitives (`stripeDiagnostic`, the env readers below)
  and differ only in what they print. This one names which fixed check failed
  and nothing else: never Stripe's error text, never a key, never an admin
  identity. Whether checkout is open is already visible on /pricing to anyone
  who looks, so a boolean here tells a prober nothing they could not already
  see; the reason a check failed is exactly the part that would help someone
  looking for a way in, and that stays behind the admin route.
*/

export interface BillingHealthCheck {
  name: string;
  ok: boolean;
}

export interface BillingHealth {
  ok: boolean;
  checks: BillingHealthCheck[];
}

/** The six Price ids checkout can charge — see lib/billing/env.ts's PRICE_VARS. */
export async function billingHealth(): Promise<BillingHealth> {
  const checks: BillingHealthCheck[] = [];
  const add = (name: string, ok: boolean) => checks.push({ name, ok });

  add("accounts_enabled", accountsEnabled());
  add("supabase_configured", supabaseConfigured());

  const key = Boolean(stripeSecretKey());
  add("stripe_key_present", key);

  // Every plan's Price id, not merely one — a health check that passed with
  // five of six missing would still call itself healthy while five plans sold
  // nothing.
  const idsPresent = PLAN_IDS.every((plan) => stripePriceId(plan) !== undefined);
  add("stripe_price_ids_present", idsPresent);

  /*
    Reachability is only worth asking with a key in hand — stripeDiagnostic
    already says so itself, but asking anyway would spend the one real network
    call this route makes on an answer already known.
  */
  const reachable = key ? (await stripeDiagnostic()).ok : false;
  add("stripe_reachable", reachable);

  /*
    And then whether those ids point at Prices that can actually be sold, at the
    amounts /pricing prints.

    This is the check the one above only looked like. An id is a string in a
    variable: it survives the Price being archived, being replaced, being on
    another Stripe account, and the catalogue here being edited without Stripe
    being updated to match. Every one of those reads as healthy to
    `stripe_price_ids_present`, and every one of them is a learner pressing
    Subscribe and getting nothing — or worse, being charged an amount the page
    never showed them, which is a misleading price indication under the consumer
    law this app sets out on /terms.

    It runs the same `priceCatalogueFault` the checkout path runs before every
    sale, so the deploy cannot pass on a rule checkout would refuse.

    Asked last, and only when there is a key, six ids and a reachable Stripe:
    six reads answering "which of your six prices is wrong" are wasted on an
    account that has already failed to answer one. A skipped check reports
    false rather than true — this never claims prices are verified when they
    were not looked at.
  */
  const pricesVerifiable = key && idsPresent && reachable;
  const priceResults = pricesVerifiable ? await verifyCataloguePrices() : [];
  add("stripe_prices_match_catalogue", pricesVerifiable && priceResults.every((r) => r.ok));

  return { ok: checks.every((c) => c.ok), checks };
}
