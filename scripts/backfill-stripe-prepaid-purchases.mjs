#!/usr/bin/env node

/*
  One-time, opt-in Stripe prepaid-pass ledger backfill.

  It is intentionally separate from the read-only preflight. The default is
  dry-run; `--apply` is required before this script writes to D1. Before every
  write it proves the complete source ledger is unambiguous and that D1 has no
  conflicting or unexpected row. It then inserts only missing original-payment
  amounts, verifies the exact aggregate again, and prints no user, payment or
  subscription identifiers.

  Usage:
    SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
      node scripts/backfill-stripe-prepaid-purchases.mjs --preview

    # Only after preview has been checked and the owner expressly approves it:
    SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
      node scripts/backfill-stripe-prepaid-purchases.mjs --production --apply
*/
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  expectedStripePrepaidPurchases,
  run,
  sourceRows,
  stripeBillingCutoverReport,
  targetRows,
} from "./check-stripe-cutover-readiness.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function sqlText(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error("source payment evidence contains an unsafe SQL value");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function insertionStatement(purchase, createdAt) {
  if (!Number.isSafeInteger(purchase.amountMinor) || purchase.amountMinor <= 0) {
    throw new Error("source payment evidence contains an invalid amount");
  }
  const paymentIntent = sqlText(purchase.paymentIntentId);
  const user = sqlText(purchase.userId);
  const subscription = sqlText(purchase.subscriptionId);
  const created = sqlText(createdAt);
  /*
    The SELECT predicate keeps a stale source row from attaching an original
    amount to a missing/reassigned D1 subscription. ON CONFLICT makes a
    concurrent retry harmless; the exact re-check below decides success.
  */
  return `
    INSERT INTO stripe_prepaid_purchases (
      payment_intent_id, user_id, subscription_id, amount_minor, created_at
    )
    SELECT ${paymentIntent}, ${user}, ${subscription}, ${purchase.amountMinor}, ${created}
     WHERE EXISTS (
       SELECT 1 FROM subscriptions
        WHERE id = ${subscription}
          AND user_id = ${user}
          AND provider = 'stripe'
          AND external_subscription_id = ${paymentIntent}
     )
    ON CONFLICT(payment_intent_id) DO NOTHING;
  `;
}

async function applyD1Statements(config, statements) {
  if (statements.length === 0) return;
  const directory = await mkdtemp(join(tmpdir(), "bandup-stripe-prepaid-"));
  const file = join(directory, "backfill.sql");
  try {
    await writeFile(file, ["BEGIN IMMEDIATE;", ...statements, "COMMIT;"].join("\n"), { mode: 0o600 });
    await run("npx", [
      "wrangler", "d1", "execute", "BANDUP_DB", "--config", config, "--remote", "--yes", "--file", file,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function parseArgs(args) {
  const selected = new Set(args);
  const preview = selected.has("--preview");
  const production = selected.has("--production");
  const apply = selected.has("--apply");
  if (preview === production || selected.size !== (apply ? 2 : 1)) {
    throw new Error("choose exactly one target (--preview or --production), optionally followed by --apply");
  }
  return { target: production ? "production" : "preview", apply };
}

export function backfillDecision(sourceSubscriptions, sourceEvents, targetPurchases) {
  const report = stripeBillingCutoverReport(sourceSubscriptions, sourceEvents, targetPurchases);
  const blocked = report.unverifiableSource > 0
    || report.conflictingEvidence > 0
    || report.malformedTarget > 0
    || report.mismatchedTarget > 0
    || report.unexpectedTarget > 0;
  return {
    report,
    canApply: !blocked,
    missing: expectedStripePrepaidPurchases(sourceSubscriptions, sourceEvents).expected.filter((purchase) =>
      !targetPurchases.some((row) => row?.payment_intent_id === purchase.paymentIntentId),
    ),
  };
}

async function main() {
  const { target, apply } = parseArgs(process.argv.slice(2));
  const sourceUrl = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
  const sourceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!sourceUrl || !sourceKey) throw new Error("set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  const config = join(ROOT, target === "production" ? "wrangler.jsonc" : "wrangler.preview.jsonc");
  const [subscriptions, providerEvents, purchases] = await Promise.all([
    sourceRows(sourceUrl, sourceKey, "subscriptions", "id,user_id,provider,external_price_id,external_subscription_id"),
    sourceRows(sourceUrl, sourceKey, "provider_events", "provider,event_id,received_at,payload"),
    targetRows(config),
  ]);
  const decision = backfillDecision(subscriptions, providerEvents, purchases);
  process.stdout.write(`${JSON.stringify({
    target,
    mode: apply ? "apply" : "dry-run",
    ...decision.report,
    rowsEligibleToInsert: decision.missing.length,
  }, null, 2)}\n`);
  if (!decision.canApply) {
    process.exitCode = 2;
    return;
  }
  if (!apply) return;

  await applyD1Statements(config, decision.missing.map((purchase) =>
    insertionStatement(purchase, new Date().toISOString()),
  ));
  const finalPurchases = await targetRows(config);
  const finalReport = stripeBillingCutoverReport(subscriptions, providerEvents, finalPurchases);
  process.stdout.write(`${JSON.stringify({ target, verification: finalReport }, null, 2)}\n`);
  if (!finalReport.ready) process.exitCode = 2;
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`Stripe prepaid backfill failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
