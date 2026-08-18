import type { AiRoute } from "@/lib/usage/limits";
import {
  cloudflareBackfillAiCostEventRow,
  cloudflareBackfillProgressSnapshotRow,
  cloudflareBackfillSubscriptionRow,
  cloudflareBackfillUsageEventRow,
  type CloudflareBackfillAiCostEventRow,
  type CloudflareBackfillProgressSnapshotRow,
  type CloudflareBackfillSubscriptionRow,
  type CloudflareBackfillUsageEventRow,
} from "@/lib/auth/supabase";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";
import {
  cloudflareDomainDrift,
  type CloudflareDomainDrift,
  type DomainDriftOptions,
} from "./domain-drift";
import { backfillCloudflareSubscription } from "./billing-replica";
import { backfillCloudflareProgressSnapshot } from "./learner-data";
import {
  backfillCloudflareAiCostEvent,
  backfillCloudflareUsageEvent,
} from "./usage-cost-replica";

/*
  Repairs the rows lib/cloudflare/domain-drift.ts already named as wrong,
  Supabase -> D1, and only in that direction.

  ---------------------------------------------------------------------------
  Why these four domains and no others

  Every domain here has an existing mirror writer this module can reuse
  unchanged (or a narrow variant added next to it, see the `backfillCloudflare*`
  functions in billing-replica.ts, learner-data.ts and usage-cost-replica.ts)
  and a Supabase read narrow enough to fetch exactly the drifted row and
  nothing else (lib/auth/supabase.ts). `profiles`, `usernames`,
  `provider_events` and `ai_cost_coverage` have neither wired up here and are
  therefore not repaired by this module, however they may drift — see the
  module doc comment on the admin route for the full list of what this does
  not cover.

  ---------------------------------------------------------------------------
  Why driving this from cloudflareDomainDrift is safe and not merely
  convenient

  domain-drift.ts already computes, per domain, which keys Supabase has that
  D1 does not (`missingInTarget`, an insert) and which keys both hold with
  different row fingerprints (`fingerprintMismatch`, an update — the row
  could be stale in D1 *or* newer than Supabase's read of it a moment later;
  see below). This asks it for exactly that, once, and repairs exactly what it
  names. `missingInSource` — a key D1 has that Supabase does not — is reported
  and never written to: Supabase is authoritative, and a D1-only row is
  either an account this backfill must not touch (see the deletion guard
  below) or a genuine Cloudflare-side anomaly outside what a Supabase-sourced
  repair can fix.

  ---------------------------------------------------------------------------
  Why a write is still safe when the row is no longer actually stale

  The gap between domain-drift.ts's read and this module's write is not
  atomic: a live write could land in between, on either side. Every writer
  this module calls carries its own forward-only ordering guard (the same one
  the live dual-write path uses — see lib/cloudflare/source-clock.ts's
  `canonicalCloudflareSourceClock` and each writer's `WHERE ... >=` clause),
  so a row that turned out to be current-or-newer by the time this reaches it
  is left alone and reported as such, never overwritten backwards.

  ---------------------------------------------------------------------------
  Why every write is re-checked against deletion here, not only inside the
  writer

  Three of the four writers guard `account_deletion_tombstones` themselves
  (progress snapshots always; subscriptions and usage events only through the
  session-scoped functions this module deliberately does not call — see the
  backfill variants' doc comments). None of them checks `app_users.deleted_at`
  directly. This module checks both, for every user-scoped row, before ever
  calling a writer: a live account whose deletion tombstone has already been
  purged still has `deleted_at` set, and the three accounts a human operator
  just marked deleted specifically to clear orphans (see the PR this shipped
  in) must never come back through a backfill that means well.

  ---------------------------------------------------------------------------
  Why this is bounded and resumable without its own cursor

  A row this module successfully repairs stops drifting, so it drops out of
  `cloudflareDomainDrift`'s comparison on the next call and the next-oldest
  drifted key rises to the front of the same bucket. Calling this repeatedly
  with the same `rowLimit` therefore walks the whole drifted set in bounded
  slices with no separate resume token to lose — as long as `rowLimit` itself
  covers the domain in one scan (the default does, generously, for anything
  this incident-sized; `drift.complete` says so either way and this always
  reports it rather than implying full coverage).
*/

export const BACKFILL_DOMAINS = [
  "progress_snapshots",
  "subscriptions",
  "usage_events",
  "ai_cost_events",
] as const;

export type BackfillDomain = typeof BACKFILL_DOMAINS[number];

export function isBackfillDomain(value: string): value is BackfillDomain {
  return (BACKFILL_DOMAINS as readonly string[]).includes(value);
}

export const DEFAULT_BACKFILL_APPLY_LIMIT = 50;
const MAX_BACKFILL_APPLY_LIMIT = 200;

export type BackfillRowBucket = "missing_in_target" | "fingerprint_mismatch";

export type BackfillRowStatus =
  /** Dry run only: this is what applying would attempt. */
  | "would_insert"
  | "would_update"
  /** Applied: the row was written and D1 changed. */
  | "inserted"
  | "updated"
  /** Never attempted: the resolved account is deleted or mid-deletion in D1. */
  | "skipped_deleted_account"
  /** Attempted, but the writer's own ordering guard left a current-or-newer
      D1 row alone rather than rolling it back. */
  | "skipped_target_current"
  /** The row named by the drift scan a moment ago is gone from Supabase now
      (deleted between the scan and this write). Nothing was written. */
  | "skipped_source_row_gone"
  /** The write was attempted and failed. Never a database error string. */
  | "error";

export interface BackfillRowResult {
  key: string;
  bucket: BackfillRowBucket;
  status: BackfillRowStatus;
}

export interface DomainBackfillReport {
  domain: BackfillDomain;
  apply: boolean;
  status: CloudflareDomainDrift["status"];
  /** False when the drift scan itself was capped before the domain's end. */
  driftComplete: boolean;
  comparedThroughKey: string | null;
  rowLimit: number;
  applyLimit: number;
  missingInTargetTotal: number;
  fingerprintMismatchTotal: number;
  /** Reported, never written: D1-only rows are out of scope, see module doc. */
  missingInSourceTotal: number;
  /** True when more drifted rows exist than `applyLimit` covered this call. */
  truncated: boolean;
  rows: BackfillRowResult[];
}

export interface DomainBackfillOptions {
  apply?: boolean;
  rowLimit?: number;
  applyLimit?: number;
  /** Injected by tests in place of the real Supabase source-row reads. */
  fetchers?: Partial<SourceFetchers>;
  /** Injected by tests in place of the restricted Supabase drift RPC. */
  readSourcePage?: DomainDriftOptions["readSourcePage"];
  /** Called for a write that threw, before it is folded into `"error"`. */
  onError?: (domain: BackfillDomain, key: string, error: unknown) => void;
}

interface SourceFetchers {
  progressSnapshot: typeof cloudflareBackfillProgressSnapshotRow;
  usageEvent: typeof cloudflareBackfillUsageEventRow;
  aiCostEvent: typeof cloudflareBackfillAiCostEventRow;
  subscription: typeof cloudflareBackfillSubscriptionRow;
}

const DEFAULT_FETCHERS: SourceFetchers = {
  progressSnapshot: cloudflareBackfillProgressSnapshotRow,
  usageEvent: cloudflareBackfillUsageEventRow,
  aiCostEvent: cloudflareBackfillAiCostEventRow,
  subscription: cloudflareBackfillSubscriptionRow,
};

/** True when the resolved account is deleted, or mid-deletion, in D1. */
async function cloudflareBackfillUserIsBlocked(
  bindings: BandUpCloudflareBindings,
  userId: string,
): Promise<boolean> {
  const row = await bindings.db.prepare(`
    SELECT
      (SELECT 1 FROM app_users WHERE id = ? AND deleted_at IS NOT NULL) AS deleted,
      (SELECT 1 FROM account_deletion_tombstones WHERE user_id = ?) AS tombstoned
  `).bind(userId, userId).first<{ deleted: number | null; tombstoned: number | null }>();
  return Boolean(row?.deleted) || Boolean(row?.tombstoned);
}

/**
 * Bootstraps a bare `app_users` row so a foreign key does not reject the
 * repaired child row, without ever touching an existing row's email — the
 * same "never clobber, only create" contract the three `backfillCloudflare*`
 * writers this module calls document on themselves.
 */
async function ensureBareCloudflareUser(
  bindings: BandUpCloudflareBindings,
  userId: string,
): Promise<void> {
  const stamp = new Date().toISOString();
  await bindings.db.prepare(`
    INSERT OR IGNORE INTO app_users (id, identity_provider, role, created_at, updated_at)
    VALUES (?, 'supabase', 'user', ?, ?)
  `).bind(userId, stamp, stamp).run();
}

interface DriftKeys {
  missingInTarget: string[];
  fingerprintMismatch: string[];
}

function driftKeys(drift: CloudflareDomainDrift, applyLimit: number): DriftKeys {
  return {
    missingInTarget: drift.missingInTarget.sample.slice(0, applyLimit),
    fingerprintMismatch: drift.fingerprintMismatch.sample.slice(
      0,
      Math.max(0, applyLimit - Math.min(drift.missingInTarget.sample.length, applyLimit)),
    ),
  };
}

/**
 * One row's whole lifecycle: fetch the current Supabase state, check the
 * deletion guard, then either report or apply. `write` receives the fetched
 * row already narrowed to non-null, and returns whether D1 actually changed —
 * `false` means the writer's own ordering guard left a current-or-newer row
 * alone.
 */
async function repairOneRow<Row>(
  domain: BackfillDomain,
  key: string,
  bucket: BackfillRowBucket,
  apply: boolean,
  bindings: BandUpCloudflareBindings,
  fetch: () => Promise<Row | null>,
  userIdOf: (row: Row) => string | null,
  write: (row: Row) => Promise<{ changed: boolean }>,
  onError?: DomainBackfillOptions["onError"],
): Promise<BackfillRowResult> {
  try {
    const row = await fetch();
    if (!row) return { key, bucket, status: "skipped_source_row_gone" };
    const userId = userIdOf(row);
    if (userId && await cloudflareBackfillUserIsBlocked(bindings, userId)) {
      return { key, bucket, status: "skipped_deleted_account" };
    }
    if (!apply) {
      return { key, bucket, status: bucket === "missing_in_target" ? "would_insert" : "would_update" };
    }
    if (userId) await ensureBareCloudflareUser(bindings, userId);
    const { changed } = await write(row);
    if (!changed) return { key, bucket, status: "skipped_target_current" };
    return { key, bucket, status: bucket === "missing_in_target" ? "inserted" : "updated" };
  } catch (error) {
    onError?.(domain, key, error);
    return { key, bucket, status: "error" };
  }
}

async function repairRow(
  domain: BackfillDomain,
  key: string,
  bucket: BackfillRowBucket,
  apply: boolean,
  bindings: BandUpCloudflareBindings,
  fetchers: SourceFetchers,
  onError?: DomainBackfillOptions["onError"],
): Promise<BackfillRowResult> {
  if (domain === "progress_snapshots") {
    const [userId, storeKey] = key.split("/");
    return repairOneRow<CloudflareBackfillProgressSnapshotRow>(
      domain, key, bucket, apply, bindings,
      () => (userId && storeKey ? fetchers.progressSnapshot(userId, storeKey) : Promise.resolve(null)),
      (row) => row.userId,
      async (row) => ({
        changed: await backfillCloudflareProgressSnapshot(
          row.userId,
          { storeKey: row.storeKey, payload: row.payload },
          row.updatedAt,
          bindings,
        ),
      }),
      onError,
    );
  }
  if (domain === "subscriptions") {
    return repairOneRow<CloudflareBackfillSubscriptionRow>(
      domain, key, bucket, apply, bindings,
      () => fetchers.subscription(key),
      (row) => row.userId,
      async (row) => {
        const outcome = await backfillCloudflareSubscription({
          id: row.id,
          userId: row.userId,
          provider: row.provider,
          status: row.status,
          tier: row.tier,
          customerId: row.customerId,
          subscriptionId: row.subscriptionId,
          priceId: row.priceId,
          currentPeriodEnd: row.currentPeriodEnd,
          cancelAtPeriodEnd: row.cancelAtPeriodEnd,
          providerEventAt: row.providerEventAt,
          verifiedAt: row.verifiedAt,
          raw: row.raw,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }, bindings);
        return { changed: outcome.success && outcome.changed };
      },
      onError,
    );
  }
  if (domain === "usage_events") {
    return repairOneRow<CloudflareBackfillUsageEventRow>(
      domain, key, bucket, apply, bindings,
      () => fetchers.usageEvent(key),
      (row) => row.userId,
      async (row) => {
        // An idempotent upsert with no ordering concept of its own: Supabase
        // is the atomic meter of record, so a successful write always counts.
        const success = await backfillCloudflareUsageEvent({
          id: row.id,
          userId: row.userId,
          route: row.route as AiRoute,
          ipHash: row.ipHash,
          outcome: row.outcome as "admitted" | "denied_quota" | "denied_rate",
          createdAt: row.createdAt,
        }, bindings);
        return { changed: success };
      },
      onError,
    );
  }
  // ai_cost_events carries no user_id (see cloudflare/migrations/0001), so
  // there is no account to check and no deletion guard to apply here.
  return repairOneRow<CloudflareBackfillAiCostEventRow>(
    domain, key, bucket, apply, bindings,
    () => fetchers.aiCostEvent(key),
    () => null,
    async (row) => {
      const success = await backfillCloudflareAiCostEvent({
        id: row.id,
        source: row.source,
        providerRequestId: row.providerRequestId,
        externalReference: row.externalReference,
        route: row.route,
        model: row.model,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheCreationInputTokens: row.cacheCreationInputTokens,
        cacheCreation5mInputTokens: row.cacheCreation5mInputTokens,
        cacheCreation1hInputTokens: row.cacheCreation1hInputTokens,
        cacheReadInputTokens: row.cacheReadInputTokens,
        costUsd: row.costUsd,
        occurredAt: row.occurredAt,
        recordedAt: row.recordedAt,
      }, bindings);
      return { changed: success };
    },
    onError,
  );
}

/** Plans (and, only with `apply: true`, applies) the repair for one domain. */
export async function backfillCloudflareDomain(
  domain: BackfillDomain,
  providedBindings?: BandUpCloudflareBindings,
  options: DomainBackfillOptions = {},
): Promise<DomainBackfillReport> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const apply = options.apply === true;
  const applyLimit = Math.max(
    1,
    Math.min(options.applyLimit ?? DEFAULT_BACKFILL_APPLY_LIMIT, MAX_BACKFILL_APPLY_LIMIT),
  );
  const fetchers: SourceFetchers = { ...DEFAULT_FETCHERS, ...options.fetchers };

  const drift = await cloudflareDomainDrift(domain, bindings, {
    rowLimit: options.rowLimit,
    sampleLimit: applyLimit,
    readSourcePage: options.readSourcePage,
  });

  const base = {
    domain,
    apply,
    status: drift.status,
    driftComplete: drift.complete,
    comparedThroughKey: drift.comparedThroughKey,
    rowLimit: drift.rowLimit,
    applyLimit,
    missingInTargetTotal: drift.missingInTarget.total,
    fingerprintMismatchTotal: drift.fingerprintMismatch.total,
    missingInSourceTotal: drift.missingInSource.total,
  };

  if (drift.status === "unavailable" || drift.status === "equal") {
    return { ...base, truncated: false, rows: [] };
  }

  const keys = driftKeys(drift, applyLimit);
  const rows: BackfillRowResult[] = [];
  for (const key of keys.missingInTarget) {
    rows.push(await repairRow(domain, key, "missing_in_target", apply, bindings, fetchers, options.onError));
  }
  for (const key of keys.fingerprintMismatch) {
    rows.push(await repairRow(domain, key, "fingerprint_mismatch", apply, bindings, fetchers, options.onError));
  }

  const attempted = keys.missingInTarget.length + keys.fingerprintMismatch.length;
  const drifted = drift.missingInTarget.total + drift.fingerprintMismatch.total;
  return { ...base, truncated: attempted < drifted, rows };
}

/** Plans (and, only with `apply: true`, applies) every domain this covers. */
export async function backfillCloudflareDomains(
  domains: readonly BackfillDomain[] = BACKFILL_DOMAINS,
  providedBindings?: BandUpCloudflareBindings,
  options: DomainBackfillOptions = {},
): Promise<DomainBackfillReport[]> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const reports: DomainBackfillReport[] = [];
  // Sequential on purpose, matching cloudflareDomainDriftReport: this already
  // runs a full drift scan per domain, and applying writes concurrently across
  // domains would multiply the load on a live Supabase and a live D1 for no
  // benefit this incident's row counts need.
  for (const domain of domains) {
    reports.push(await backfillCloudflareDomain(domain, bindings, options));
  }
  return reports;
}
