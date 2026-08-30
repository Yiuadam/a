import { assertServerOnly } from "@/lib/auth/server-only";
import { listStripeCutoverSourceEvidence } from "@/lib/auth/supabase";
import { requireBandUpCloudflareBindings, type BandUpCloudflareBindings } from "./bindings";
import { stripeBillingCutoverReport } from "./stripe-cutover-preflight";

const MODULE = "lib/cloudflare/stripe-cutover-readiness.ts";

/**
 * Server-only, read-only live billing parity proof. It does not expose source
 * subscriptions, events, payment identifiers, account identifiers or amounts.
 */
export async function stripeCutoverReadinessReport(
  providedBindings?: BandUpCloudflareBindings,
) {
  assertServerOnly(MODULE);
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const [source, target] = await Promise.all([
    listStripeCutoverSourceEvidence(),
    bindings.db.prepare(`
      SELECT payment_intent_id, user_id, subscription_id, amount_minor
        FROM stripe_prepaid_purchases
       ORDER BY payment_intent_id
    `).all<Record<string, unknown>>(),
  ]);
  if (!target.success) throw new Error("Cloudflare prepaid purchase ledger could not be read");
  return stripeBillingCutoverReport(source.subscriptions, source.providerEvents, target.results);
}
