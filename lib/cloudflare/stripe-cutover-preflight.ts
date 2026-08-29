/*
  Pure, Worker-compatible evidence comparison for the one-time Stripe cutover.
  It deliberately works on opaque source rows and exposes only aggregate
  counts to callers. The Node CLI and the temporary owner migration endpoint
  share this exact logic, so their cutover verdict cannot drift.
*/

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Extract only the immutable original-payment facts needed to classify refunds. */
export function prepaidEvidenceFromProviderEvent(row: unknown) {
  const source = object(row);
  if (source?.provider !== "stripe") return null;
  const payload = object(source.payload);
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
  const amountMinor = positiveInteger(checkout.amount_total);
  if (!paymentIntentId || !userId || amountMinor === null) {
    return null;
  }
  return { paymentIntentId, userId, amountMinor };
}

function walletSubscriptions(rows: readonly unknown[]) {
  return rows.flatMap((row) => {
    const source = object(row);
    return source?.provider === "stripe"
      && typeof source.external_price_id === "string"
      && source.external_price_id.startsWith("wallet:")
      ? [source]
      : [];
  });
}

/**
 * Builds the private, immutable original-payment ledger expected in D1. The
 * values never leave the server except as parameterised D1 rows; callers print
 * only aggregate counts from `stripeBillingCutoverReport`.
 */
export function expectedStripePrepaidPurchases(
  sourceSubscriptions: unknown,
  sourceEvents: unknown,
) {
  const walletRows = walletSubscriptions(Array.isArray(sourceSubscriptions) ? sourceSubscriptions : []);
  const evidenceByIntent = new Map<string, { userId: string; amountMinor: number }>();
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

  const expected = new Map<string, { userId: string; subscriptionId: string; amountMinor: number }>();
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

  return {
    sourceWalletSubscriptions: walletRows.length,
    sourcePaymentEvidence: evidenceByIntent.size,
    unverifiableSource,
    conflictingEvidence,
    expected: [...expected.entries()].map(([paymentIntentId, value]) => ({ paymentIntentId, ...value })),
  };
}

/** Compare source payment evidence to D1 without returning any payment or account identifier. */
export function stripeBillingCutoverReport(
  sourceSubscriptions: unknown,
  sourceEvents: unknown,
  targetPurchases: unknown,
) {
  const source = expectedStripePrepaidPurchases(sourceSubscriptions, sourceEvents);
  const expected = new Map(source.expected.map((row) => [row.paymentIntentId, row]));
  const target = new Map<string, { userId: string; subscriptionId: string; amountMinor: number }>();
  let malformedTarget = 0;
  for (const row of Array.isArray(targetPurchases) ? targetPurchases : []) {
    const targetRow = object(row);
    const paymentIntentId = string(targetRow?.payment_intent_id);
    const userId = string(targetRow?.user_id);
    const subscriptionId = string(targetRow?.subscription_id);
    const amountMinor = positiveInteger(targetRow?.amount_minor);
    if (!paymentIntentId || !userId || !subscriptionId || amountMinor === null) {
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
    sourceWalletSubscriptions: source.sourceWalletSubscriptions,
    sourcePaymentEvidence: source.sourcePaymentEvidence,
    expectedPrepaidPurchases: expected.size,
    targetPrepaidPurchases: target.size,
    unverifiableSource: source.unverifiableSource,
    conflictingEvidence: source.conflictingEvidence,
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
