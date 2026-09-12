import { accountRuntimeEnabled } from "@/lib/auth/runtime";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { nativeStripeBillingActive } from "@/lib/cloudflare/native-billing-readiness";
import { billingClosed, stripeSecretKey, stripePriceId, stripeWebhookSecret } from "./env";
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

  ---------------------------------------------------------------------------
  Why a closed shop is still a healthy one

  BILLING_CLOSED exists so the owner can pause sales without that reading as
  breakage — see billingClosed() in lib/billing/env.ts. Closing sales is done
  by removing the STRIPE_PRICE_* secrets, so `stripe_price_ids_present` and
  `stripe_prices_match_catalogue` would otherwise fail here every hour, for a
  reason that is not a fault: there is nothing wrong to fix, because nothing
  is supposed to be for sale. Reporting that as unhealthy would be the 16
  August failure in miniature — a red check nobody needs to act on teaches
  whoever is watching to stop trusting red checks at all.

  So while billingClosed() is true, those two checks are skipped rather than
  forced to `ok: true`: nothing was verified, so nothing claims to have been.
  In their place is one check, `billing_closed_by_owner`, which is `ok: true`
  for as long as the switch reads that way — closed is the state this
  deployment is deliberately in, not a check that can fail. `stripe_key_present`,
  `stripe_webhook_secret_present` and `stripe_reachable` stay real regardless:
  both a renewal landing through the webhook and a subscriber reaching the
  billing portal need the key and the webhook secret, whether or not anything
  new can be bought.
*/

export interface BillingHealthCheck {
  name: string;
  ok: boolean;
}

export interface BillingHealth {
  ok: boolean;
  checks: BillingHealthCheck[];
}

/** The four Price ids checkout can charge — see lib/billing/env.ts's PRICE_VARS. */
export async function billingHealth(): Promise<BillingHealth> {
  const checks: BillingHealthCheck[] = [];
  const add = (name: string, ok: boolean) => checks.push({ name, ok });

  add("accounts_runtime_enabled", accountRuntimeEnabled());
  add("billing_storage_configured", supabaseConfigured() || nativeStripeBillingActive());

  const key = Boolean(stripeSecretKey());
  add("stripe_key_present", key);

  /*
    The webhook secret, which was the one Stripe value nothing watched.

    Without it every delivery is refused with a 503 — the route will not trust
    an unverified body, and it is right not to — so Stripe retries for a while
    and then gives up. Nothing errors on this side, no learner sees anything,
    and the only symptom is that people who paid never get what they paid for.
    That is exactly the shape of failure a health check exists for: silent,
    delayed, and about money.

    Presence only. Whether it is the *correct* secret cannot be known without a
    signed delivery to test it against, and this route does not have one.
  */
  add("stripe_webhook_secret_present", Boolean(stripeWebhookSecret()));

  /*
    Reachability is only worth asking with a key in hand — stripeDiagnostic
    already says so itself, but asking anyway would spend the one real network
    call this route makes on an answer already known. It does not depend on a
    single Price id, so it stays a real check whether or not sales are open:
    the portal and the webhook both still need this key to work.
  */
  const reachable = key ? (await stripeDiagnostic()).ok : false;
  add("stripe_reachable", reachable);

  if (billingClosed()) {
    // See "Why a closed shop is still a healthy one" above.
    add("billing_closed_by_owner", true);
  } else {
    // Every plan's Price id, not merely one — a health check that passed with
    // three of four missing would still call itself healthy while three plans sold
    // nothing.
    const idsPresent = PLAN_IDS.every((plan) => stripePriceId(plan) !== undefined);
    add("stripe_price_ids_present", idsPresent);

    /*
      And then whether those ids point at Prices that can actually be sold, at
      the amounts /pricing prints.

      This is the check the one above only looked like. An id is a string in a
      variable: it survives the Price being archived, being replaced, being on
      another Stripe account, and the catalogue here being edited without
      Stripe being updated to match. Every one of those reads as healthy to
      `stripe_price_ids_present`, and every one of them is a learner pressing
      Subscribe and getting nothing — or worse, being charged an amount the
      page never showed them, which is a misleading price indication under the
      consumer law this app sets out on /terms.

      It runs the same `priceCatalogueFault` the checkout path runs before
      every sale, so the deploy cannot pass on a rule checkout would refuse.

      Asked last, and only when there is a key, four ids and a reachable
      Stripe: four reads answering "which of your four prices is wrong" are
      wasted on an account that has already failed to answer one. A skipped
      check reports false rather than true — this never claims prices are
      verified when they were not looked at.
    */
    const pricesVerifiable = key && idsPresent && reachable;
    const priceResults = pricesVerifiable ? await verifyCataloguePrices() : [];
    add("stripe_prices_match_catalogue", pricesVerifiable && priceResults.every((r) => r.ok));
  }

  return { ok: checks.every((c) => c.ok), checks };
}
