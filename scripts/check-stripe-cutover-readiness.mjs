#!/usr/bin/env node

/*
  Read-only evidence for the last high-risk billing cutover step.

  A one-time Stripe pass needs its original paid amount to distinguish a full
  refund (revoke access) from a partial refund (keep access).  Older D1
  subscription rows have the current Stripe state but not necessarily that
  original amount, so a new D1 webhook writer must not be enabled merely
  because the ordinary subscription parity fingerprint is equal.

  This script reads the legacy Stripe subscription/event evidence and the D1
  `stripe_prepaid_purchases` ledger. It writes neither system, prints only
  aggregate counts, and exits non-zero unless every historic wallet pass has
  an exact original-amount record in D1.

  Usage:
    SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
      node scripts/check-stripe-cutover-readiness.mjs --preview

  Add `--production` only after preview is equal. The production option is
  still read-only; it exists to make the destination impossible to mistake.
*/

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { supabaseServiceHeaders } from "../lib/auth/supabase-service-key.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PAGE_SIZE = 100;

function string(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** Extract only the immutable original-payment facts needed to classify refunds. */
export function prepaidEvidenceFromProviderEvent(row) {
  if (row?.provider !== "stripe") return null;
  const payload = object(row.payload);
  if (
    payload?.type !== "checkout.session.completed"
    && payload?.type !== "checkout.session.async_payment_succeeded"
  ) return null;
  const data = object(payload.data);
  const checkout = object(data?.object);
  if (checkout?.mode !== "payment" || checkout?.payment_status !== "paid") return null;
  const metadata = object(checkout.metadata);
  const paymentIntentId = string(checkout.payment_intent);
  const userId = string(metadata?.bandup_user_id);
  const amountMinor = checkout.amount_total;
  if (!paymentIntentId || !userId || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return null;
  }
  return { paymentIntentId, userId, amountMinor };
}

function walletSubscriptions(rows) {
  return rows.filter((row) =>
    row?.provider === "stripe"
    && typeof row.external_price_id === "string"
    && row.external_price_id.startsWith("wallet:")
  );
}

/**
 * Compare source payment evidence to D1 without exposing payment-intent or
 * account identifiers in the report. `ready` is deliberately all-or-nothing.
 */
export function stripeBillingCutoverReport(sourceSubscriptions, sourceEvents, targetPurchases) {
  const walletRows = walletSubscriptions(Array.isArray(sourceSubscriptions) ? sourceSubscriptions : []);
  const evidenceByIntent = new Map();
  let conflictingEvidence = 0;
  for (const row of Array.isArray(sourceEvents) ? sourceEvents : []) {
    const evidence = prepaidEvidenceFromProviderEvent(row);
    if (!evidence) continue;
    const existing = evidenceByIntent.get(evidence.paymentIntentId);
    if (
      existing
      && (existing.userId !== evidence.userId || existing.amountMinor !== evidence.amountMinor)
    ) {
      conflictingEvidence += 1;
      continue;
    }
    evidenceByIntent.set(evidence.paymentIntentId, evidence);
  }

  const expected = new Map();
  let unverifiableSource = 0;
  for (const row of walletRows) {
    const subscriptionId = string(row.id);
    const userId = string(row.user_id);
    const paymentIntentId = string(row.external_subscription_id);
    if (!subscriptionId || !userId || !paymentIntentId || expected.has(paymentIntentId)) {
      unverifiableSource += 1;
      continue;
    }
    const evidence = evidenceByIntent.get(paymentIntentId);
    if (!evidence || evidence.userId !== userId) {
      unverifiableSource += 1;
      continue;
    }
    expected.set(paymentIntentId, {
      userId,
      subscriptionId,
      amountMinor: evidence.amountMinor,
    });
  }

  const target = new Map();
  let malformedTarget = 0;
  for (const row of Array.isArray(targetPurchases) ? targetPurchases : []) {
    const paymentIntentId = string(row.payment_intent_id);
    const userId = string(row.user_id);
    const subscriptionId = string(row.subscription_id);
    const amountMinor = row.amount_minor;
    if (!paymentIntentId || !userId || !subscriptionId || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      malformedTarget += 1;
      continue;
    }
    target.set(paymentIntentId, { userId, subscriptionId, amountMinor });
  }

  let missingTarget = 0;
  let mismatchedTarget = 0;
  for (const [paymentIntentId, expectedPurchase] of expected) {
    const targetPurchase = target.get(paymentIntentId);
    if (!targetPurchase) {
      missingTarget += 1;
      continue;
    }
    if (
      targetPurchase.userId !== expectedPurchase.userId
      || targetPurchase.subscriptionId !== expectedPurchase.subscriptionId
      || targetPurchase.amountMinor !== expectedPurchase.amountMinor
    ) mismatchedTarget += 1;
  }

  let unexpectedTarget = 0;
  for (const paymentIntentId of target.keys()) {
    if (!expected.has(paymentIntentId)) unexpectedTarget += 1;
  }

  const report = {
    sourceWalletSubscriptions: walletRows.length,
    sourcePaymentEvidence: evidenceByIntent.size,
    expectedPrepaidPurchases: expected.size,
    targetPrepaidPurchases: target.size,
    unverifiableSource,
    conflictingEvidence,
    malformedTarget,
    missingTarget,
    mismatchedTarget,
    unexpectedTarget,
  };
  return {
    ...report,
    ready: Object.values(report).every((value) => value === 0)
      || (
        report.sourceWalletSubscriptions > 0
        && report.expectedPrepaidPurchases === report.sourceWalletSubscriptions
        && report.targetPrepaidPurchases === report.expectedPrepaidPurchases
        && report.unverifiableSource === 0
        && report.conflictingEvidence === 0
        && report.malformedTarget === 0
        && report.missingTarget === 0
        && report.mismatchedTarget === 0
        && report.unexpectedTarget === 0
      ),
  };
}

function run(program, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${program} exited ${code ?? "unknown"}: ${stderr.slice(-800)}`));
    });
  });
}

function d1Rows(output) {
  for (let start = output.indexOf("["); start >= 0; start = output.indexOf("[", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < output.length; index += 1) {
      const character = output[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') { quoted = true; continue; }
      if (character === "[") depth += 1;
      if (character !== "]") continue;
      depth -= 1;
      if (depth !== 0) continue;
      try {
        const result = JSON.parse(output.slice(start, index + 1));
        if (Array.isArray(result) && result.every((batch) => batch?.success === true && Array.isArray(batch.results))) {
          return result.flatMap((batch) => batch.results);
        }
      } catch {
        // Try the next JSON-looking range and fail closed if none are valid.
      }
    }
  }
  throw new Error("Cloudflare returned no valid D1 query result");
}

async function sourceRows(sourceUrl, sourceKey, table, select) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const endpoint = new URL(`/rest/v1/${table}`, sourceUrl);
    endpoint.searchParams.set("select", select);
    endpoint.searchParams.set("order", table === "subscriptions" ? "id.asc" : "received_at.asc,event_id.asc");
    endpoint.searchParams.set("offset", String(offset));
    endpoint.searchParams.set("limit", String(PAGE_SIZE));
    if (table === "subscriptions") endpoint.searchParams.set("provider", "eq.stripe");
    else endpoint.searchParams.set("provider", "eq.stripe");
    const response = await fetch(endpoint, {
      headers: supabaseServiceHeaders(sourceKey, "application/json"),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Supabase ${table} read failed (${response.status})`);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error(`Supabase ${table} returned an invalid response`);
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

async function targetRows(config) {
  const output = await run("npx", [
    "wrangler", "d1", "execute", "BANDUP_DB", "--config", config, "--remote", "--yes", "--json",
    "--command", "SELECT payment_intent_id,user_id,subscription_id,amount_minor FROM stripe_prepaid_purchases ORDER BY payment_intent_id",
  ]);
  return d1Rows(output);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const preview = args.has("--preview");
  const production = args.has("--production");
  if (preview === production || args.size !== 1) {
    throw new Error("choose exactly one read-only target: --preview or --production");
  }
  const sourceUrl = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
  const sourceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!sourceUrl || !sourceKey) throw new Error("set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  const config = join(ROOT, production ? "wrangler.jsonc" : "wrangler.preview.jsonc");
  const [subscriptions, providerEvents, purchases] = await Promise.all([
    sourceRows(sourceUrl, sourceKey, "subscriptions", "id,user_id,provider,external_price_id,external_subscription_id"),
    sourceRows(sourceUrl, sourceKey, "provider_events", "provider,event_id,received_at,payload"),
    targetRows(config),
  ]);
  const report = stripeBillingCutoverReport(subscriptions, providerEvents, purchases);
  process.stdout.write(`${JSON.stringify({ target: production ? "production" : "preview", ...report }, null, 2)}\n`);
  if (!report.ready) process.exitCode = 2;
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`Stripe billing cutover preflight failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
