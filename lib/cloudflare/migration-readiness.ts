import { rpc } from "@/lib/auth/supabase";
import {
  cloudflareDataMode,
  organizationDataMode,
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";
import { appSettingsParityReport, type AppSettingsParityReport } from "./app-settings-parity";
import {
  cloudflareReplicaOutboxStatus,
  type CloudflareReplicaOutboxStatus,
} from "./replica-outbox";
import { parityClock as clock } from "./source-clock";

export const MIGRATION_FINGERPRINT_VERSION = "bandup-application-data-v3";

const EXACT_DOMAINS = [
  "profiles",
  "usernames",
  "progress_snapshots",
  "subscriptions",
  "provider_events",
  "usage_events",
  "ai_cost_events",
  "ai_cost_coverage",
] as const;

const ORGANIZATION_TABLES = [
  "organization_applications",
  "organizations",
  "organization_seat_pools",
  "organization_memberships",
  "teacher_student_assignments",
  "organization_seat_allocations",
  "organization_requests",
  "practice_attempts",
  "organization_attempt_archives",
  "organization_attempt_tombstones",
  "organization_audit_log",
  "organization_command_receipts",
  "organization_sync_receipts",
] as const;

type ExactDomain = typeof EXACT_DOMAINS[number];

interface SourceFingerprintRow {
  domain: string;
  row_count: number;
  fingerprint: string;
}

export type MigrationSourceFingerprintRow = SourceFingerprintRow;

export interface MigrationDomainReadiness {
  domain: string;
  proof: "exact_identity_state_fingerprint" | "exact_records" | "target_authoritative" | "unsupported";
  ready: boolean;
  status: "equal" | "source_only" | "target_only" | "different" | "unavailable" | "authoritative" | "unsupported";
  sourceCount: number | null;
  targetCount: number | null;
  sourceFingerprint: string | null;
  targetFingerprint: string | null;
}

/**
 * The source evidence is intentionally reported separately from every domain.
 *
 * All exact domains depend on one restricted Supabase RPC. When that one
 * operation is absent, stale or unreachable, painting eight bare
 * "unavailable" labels looks like eight Cloudflare failures even though the
 * target may be healthy. This contains no source rows or database error body;
 * it merely tells the owner which side could not be proven.
 */
export interface MigrationSourceEvidence {
  status: "available" | "unavailable" | "invalid";
}

export interface CloudflareMigrationReadinessReport {
  generatedAt: string;
  fingerprintVersion: string;
  supabaseAuth: {
    included: false;
    authority: "supabase";
    reason: string;
  };
  modes: {
    learner: ReturnType<typeof cloudflareDataMode>;
    organization: ReturnType<typeof organizationDataMode>;
  };
  sourceEvidence: MigrationSourceEvidence;
  domains: MigrationDomainReadiness[];
  appSettings: AppSettingsParityReport | null;
  outbox: CloudflareReplicaOutboxStatus | null;
  unsupportedDomains: string[];
  blockers: string[];
  readyForCloudflareOnly: boolean;
}

function sha256(value: string): Promise<string> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)).then((digest) =>
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

function line(parts: Array<string | number | null>): string {
  return parts.map((part) => {
    if (part === null) return "-:";
    const value = String(part);
    return `${new TextEncoder().encode(value).byteLength}:${value}`;
  }).join("|");
}

async function targetFingerprint(
  domain: ExactDomain,
  bindings: BandUpCloudflareBindings,
): Promise<{ count: number; fingerprint: string }> {
  let rows: Record<string, unknown>[];
  if (domain === "profiles") {
    rows = (await bindings.db.prepare(`
      SELECT p.user_id id, u.email, u.role,
             p.display_name, p.birth_date, p.account_kind
        FROM learner_profiles p JOIN app_users u ON u.id = p.user_id
       WHERE u.deleted_at IS NULL ORDER BY p.user_id
    `).all()).results;
  } else if (domain === "usernames") {
    rows = (await bindings.db.prepare(`
      SELECT n.user_id, n.username
        FROM usernames n JOIN app_users u ON u.id = n.user_id
       WHERE u.deleted_at IS NULL ORDER BY n.user_id, n.username
    `).all()).results;
  } else if (domain === "progress_snapshots") {
    rows = (await bindings.db.prepare(`
      SELECT s.user_id, s.store_key, s.source_updated_at updated_at
        FROM progress_snapshots s JOIN app_users u ON u.id = s.user_id
       WHERE u.deleted_at IS NULL ORDER BY s.user_id, s.store_key
    `).all()).results;
  } else if (domain === "subscriptions") {
    rows = (await bindings.db.prepare(`
      SELECT id,user_id,provider,status,tier,external_customer_id,
             external_subscription_id,original_transaction_id,external_price_id,
             current_period_end,cancel_at_period_end,provider_event_at,
             verified_at,created_at,updated_at
        FROM subscriptions ORDER BY id
    `).all()).results;
  } else if (domain === "provider_events") {
    rows = (await bindings.db.prepare(`
      SELECT provider,event_id FROM provider_events ORDER BY provider,event_id
    `).all()).results;
  } else if (domain === "usage_events") {
    rows = (await bindings.db.prepare(`
      SELECT id,user_id,route,ip_hash,outcome,created_at FROM usage_events
       ORDER BY length(id),id
    `).all()).results;
  } else if (domain === "ai_cost_events") {
    rows = (await bindings.db.prepare(`
      SELECT id,source,provider_request_id,external_reference,route,model,
             input_tokens,output_tokens,cache_creation_input_tokens,
             cache_creation_5m_input_tokens,cache_creation_1h_input_tokens,
             cache_read_input_tokens,cost_usd,occurred_at,recorded_at
        FROM ai_cost_events
       ORDER BY length(id),id
    `).all()).results;
  } else {
    rows = (await bindings.db.prepare(`
      SELECT singleton,source,starts_at,historical_complete,recorded_at
        FROM ai_cost_coverage ORDER BY singleton
    `).all()).results;
  }

  const evidence = rows.map((row) => {
    if (domain === "profiles") return line([
      row.id as string,
      row.email as string | null,
      row.role as string,
      row.display_name as string | null,
      row.birth_date as string | null,
      row.account_kind as string | null,
    ]);
    if (domain === "usernames") return line([row.user_id as string, row.username as string]);
    if (domain === "progress_snapshots") return line([row.user_id as string, row.store_key as string, clock(row.updated_at)]);
    if (domain === "subscriptions") return line([
      row.id as string,
      row.user_id as string,
      row.provider as string,
      row.status as string,
      row.tier as string,
      row.external_customer_id as string | null,
      row.external_subscription_id as string | null,
      row.original_transaction_id as string | null,
      row.external_price_id as string | null,
      clock(row.current_period_end),
      Number(row.cancel_at_period_end) === 1 ? "true" : "false",
      clock(row.provider_event_at),
      clock(row.verified_at),
      clock(row.created_at),
      clock(row.updated_at),
    ]);
    if (domain === "provider_events") return line([row.provider as string, row.event_id as string]);
    if (domain === "usage_events") return line([
      row.id as string,
      row.user_id as string | null,
      row.route as string,
      row.ip_hash as string | null,
      row.outcome as string,
      clock(row.created_at),
    ]);
    if (domain === "ai_cost_events") return line([
      row.id as string,
      row.source as string,
      row.provider_request_id as string | null,
      row.external_reference as string | null,
      row.route as string | null,
      row.model as string | null,
      row.input_tokens as number | null,
      row.output_tokens as number | null,
      row.cache_creation_input_tokens as number | null,
      row.cache_creation_5m_input_tokens as number | null,
      row.cache_creation_1h_input_tokens as number | null,
      row.cache_read_input_tokens as number | null,
      row.cost_usd as string,
      clock(row.occurred_at),
      clock(row.recorded_at),
    ]);
    return line(["true", row.source as string, clock(row.starts_at), Number(row.historical_complete) === 1 ? "true" : "false", clock(row.recorded_at)]);
  }).sort();
  return { count: evidence.length, fingerprint: await sha256(evidence.join("\n")) };
}

export async function cloudflareTargetFingerprints(
  bindings: BandUpCloudflareBindings,
): Promise<MigrationSourceFingerprintRow[]> {
  return Promise.all(EXACT_DOMAINS.map(async (domain) => {
    const target = await targetFingerprint(domain, bindings);
    return { domain, row_count: target.count, fingerprint: target.fingerprint };
  }));
}

async function exactDomainReports(
  bindings: BandUpCloudflareBindings,
  readSource: () => Promise<SourceFingerprintRow[]>,
): Promise<{ domains: MigrationDomainReadiness[]; sourceEvidence: MigrationSourceEvidence }> {
  let sourceRows: SourceFingerprintRow[];
  try {
    sourceRows = await readSource();
  } catch {
    return {
      sourceEvidence: { status: "unavailable" },
      domains: EXACT_DOMAINS.map((domain) => ({
        domain,
        proof: "exact_identity_state_fingerprint",
        ready: false,
        status: "unavailable",
        sourceCount: null,
        targetCount: null,
        sourceFingerprint: null,
        targetFingerprint: null,
      })),
    };
  }
  const knownDomains = new Set<string>(EXACT_DOMAINS);
  const seen = new Set<string>();
  const validSource = Array.isArray(sourceRows)
    && sourceRows.length === EXACT_DOMAINS.length
    && sourceRows.every((row) => {
      if (!knownDomains.has(row.domain) || seen.has(row.domain)) return false;
      seen.add(row.domain);
      const count = Number(row.row_count);
      return Number.isSafeInteger(count)
        && count >= 0
        && /^[a-f0-9]{64}$/.test(row.fingerprint);
    });
  if (!validSource) {
    return {
      sourceEvidence: { status: "invalid" },
      domains: EXACT_DOMAINS.map((domain) => ({
        domain,
        proof: "exact_identity_state_fingerprint",
        ready: false,
        status: "unavailable",
        sourceCount: null,
        targetCount: null,
        sourceFingerprint: null,
        targetFingerprint: null,
      })),
    };
  }
  const source = new Map(sourceRows.map((row) => [row.domain, row]));
  const domains = await Promise.all(EXACT_DOMAINS.map(async (domain) => {
    const left = source.get(domain);
    try {
      const right = await targetFingerprint(domain, bindings);
      const sourceCount = left ? Number(left.row_count) : null;
      const sourceFingerprint = left?.fingerprint ?? null;
      const equal = sourceCount === right.count && sourceFingerprint === right.fingerprint;
      return {
        domain,
        proof: "exact_identity_state_fingerprint" as const,
        ready: equal,
        status: equal ? "equal" as const : sourceCount === null ? "unavailable" as const : sourceCount > right.count ? "source_only" as const : sourceCount < right.count ? "target_only" as const : "different" as const,
        sourceCount,
        targetCount: right.count,
        sourceFingerprint,
        targetFingerprint: right.fingerprint,
      };
    } catch {
      return {
        domain,
        proof: "exact_identity_state_fingerprint" as const,
        ready: false,
        status: "unavailable" as const,
        sourceCount: left ? Number(left.row_count) : null,
        targetCount: null,
        sourceFingerprint: left?.fingerprint ?? null,
        targetFingerprint: null,
      };
    }
  }));
  return { domains, sourceEvidence: { status: "available" } };
}

function organizationReport(): MigrationDomainReadiness {
  const authoritative = organizationDataMode() === "cloudflare";
  return {
    domain: "organizations",
    proof: "target_authoritative",
    ready: authoritative,
    status: authoritative ? "authoritative" : "unsupported",
    sourceCount: null,
    targetCount: null,
    sourceFingerprint: null,
    targetFingerprint: null,
  };
}

export async function cloudflareMigrationReadinessReport(
  providedBindings?: BandUpCloudflareBindings,
  options: {
    readSourceFingerprints?: () => Promise<SourceFingerprintRow[]>;
    readAppSettings?: () => Promise<AppSettingsParityReport>;
    readOutbox?: () => Promise<CloudflareReplicaOutboxStatus>;
  } = {},
): Promise<CloudflareMigrationReadinessReport> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const readSourceFingerprints = options.readSourceFingerprints
    ?? (() => rpc<SourceFingerprintRow[]>("cloudflare_migration_source_fingerprints", {}));
  const [exactResult, appSettingsResult, outboxResult] = await Promise.all([
    exactDomainReports(bindings, readSourceFingerprints),
    (options.readAppSettings?.() ?? appSettingsParityReport(bindings)).catch(() => null),
    (options.readOutbox?.() ?? cloudflareReplicaOutboxStatus(bindings)).catch(() => null),
  ]);
  const { domains: exact, sourceEvidence } = exactResult;
  const organization = organizationReport();
  const domains = [...exact, organization];
  const unsupportedDomains: string[] = [];
  if (!organization.ready) unsupportedDomains.push(...ORGANIZATION_TABLES);
  if (!appSettingsResult) unsupportedDomains.push("app_settings");
  // These runtime readers/writers still call Supabase even when the learner
  // switch says `cloudflare`. Exact stored-row parity is useful evidence, but
  // it cannot make a Cloudflare-only cutover safe until those paths exist.
  unsupportedDomains.push(
    "admin_user_directory",
    "admin_statistics",
    "billing_entitlement_runtime",
    "usage_quota_authority",
    "ai_cost_write_authority",
    "avatar_object_parity",
    "progress_payload_integrity",
    "billing_payload_object_parity",
    "provider_event_payload_object_parity",
    "cutover_write_barrier",
  );

  const blockers: string[] = [];
  if (cloudflareDataMode() !== "dual") {
    blockers.push("learner_mode: dual mode is required for live cutover proof");
  }
  for (const domain of domains) if (!domain.ready) blockers.push(`${domain.domain}: ${domain.status}`);
  if (!appSettingsResult?.readyForAppSettingsCutover) blockers.push("app_settings: not proven equal");
  if (!outboxResult) blockers.push("replica_outbox: unavailable");
  else {
    if (outboxResult.pending > 0) blockers.push(`replica_outbox: ${outboxResult.pending} pending`);
    if (outboxResult.dead > 0) blockers.push(`replica_outbox: ${outboxResult.dead} dead`);
    if (outboxResult.cleanupPending > 0) blockers.push(`replica_object_cleanup: ${outboxResult.cleanupPending} pending`);
    if (outboxResult.cleanupDead > 0) blockers.push(`replica_object_cleanup: ${outboxResult.cleanupDead} dead`);
    // A count says the mirror is stuck; only the recorded reason says why, and
    // the owner should not have to open D1 to read it.
    for (const failure of outboxResult.failures ?? []) {
      blockers.push(`replica_outbox: ${failure.count} ${failure.status} ${failure.code}`);
    }
    for (const failure of outboxResult.cleanupFailures ?? []) {
      blockers.push(`replica_object_cleanup: ${failure.count} ${failure.status} ${failure.code}`);
    }
    if ((outboxResult.blockedByAccountDeletion ?? 0) > 0) {
      blockers.push(
        `replica_outbox: ${outboxResult.blockedByAccountDeletion} blocked by account deletion`,
      );
    }
  }
  if (unsupportedDomains.length > 0) blockers.push("unsupported application-data domains remain");

  return {
    generatedAt: new Date().toISOString(),
    fingerprintVersion: MIGRATION_FINGERPRINT_VERSION,
    supabaseAuth: {
      included: false,
      authority: "supabase",
      reason: "Supabase Auth remains the identity provider and is not migrated.",
    },
    modes: { learner: cloudflareDataMode(), organization: organizationDataMode() },
    sourceEvidence,
    domains,
    appSettings: appSettingsResult,
    outbox: outboxResult,
    unsupportedDomains: [...new Set(unsupportedDomains)],
    blockers,
    readyForCloudflareOnly: blockers.length === 0,
  };
}
