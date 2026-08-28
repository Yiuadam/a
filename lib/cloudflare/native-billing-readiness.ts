import { assertServerOnly } from "@/lib/auth/server-only";
import { domainWritesToCloudflareOnly } from "./cutover-domains";

const MODULE = "lib/cloudflare/native-billing-readiness.ts";
const BILLING_DOMAIN = "billing_entitlement_runtime";

/*
  Money-moving writes need a separate explicit switch.

  `CLOUDFLARE_DATA_MODE=cloudflare` already routes learner data one way. That
  must not silently make an un-rehearsed Stripe webhook D1-authoritative on
  the same deploy. The owner can set this only after the D1 migration, source
  backfill and event-replay checks have all passed; until then the established
  Supabase transaction remains the authority.
*/
export function nativeStripeBillingActive(): boolean {
  assertServerOnly(MODULE);
  return domainWritesToCloudflareOnly(BILLING_DOMAIN)
    && String(process.env["CLOUDFLARE_NATIVE_STRIPE_BILLING"] ?? "") === "1";
}
