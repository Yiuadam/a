import { rpc } from "@/lib/auth/supabase";
import type { BandUpCloudflareBindings } from "./bindings";
import { canonicalCloudflareSourceClock } from "./source-clock";

/*
  Naming the rows that are out of parity.

  `migration-readiness.ts` compares one fingerprint and one row count per
  domain. That is enough to say a domain is wrong and nothing at all about
  which rows are wrong, so the owner is told to fix something without being
  told what. This module answers the follow-up question, in the three shapes
  drift actually takes:

    - a key Supabase has and D1 does not   (the mirror missed a write)
    - a key D1 has and Supabase does not   (a row the mirror never swept)
    - a key both hold whose row fingerprints differ (the dangerous one)

  Two properties are deliberate.

  Nothing personal crosses the boundary. Both sides emit (key, sha256 of the
  same evidence line the whole-domain fingerprint is built from). The key is an
  id, a username or a store key; no email, display name, payload or event body
  is read out of either database, and the hash cannot be turned back into one.

  Nothing is loaded whole. Both sides are read as ordered, keyset-paged
  streams and merge-joined, so memory is one page per side however large the
  table is. Reading stops at `rowLimit` rows per side and the result then says
  `complete: false` and names the key it reached. A cap that reads as a full
  comparison would be worse than no comparison at all.
*/

export const DRIFT_DOMAINS = [
  "profiles",
  "usernames",
  "progress_snapshots",
  "subscriptions",
  "provider_events",
  "usage_events",
  "ai_cost_events",
  "ai_cost_coverage",
] as const;

export type DriftDomain = typeof DRIFT_DOMAINS[number];

export const DEFAULT_DRIFT_ROW_LIMIT = 20000;
export const DEFAULT_DRIFT_SAMPLE_LIMIT = 20;
const PAGE_SIZE = 500;

export interface DomainDriftBucket {
  /** Rows found in the part of the domain that was compared. */
  total: number;
  /** At most `sampleLimit` keys, in comparison order. */
  sample: string[];
}

export interface CloudflareDomainDrift {
  domain: DriftDomain;
  status: "equal" | "drifted" | "partial" | "unavailable";
  /** False when `rowLimit` stopped the comparison before the end of the domain. */
  complete: boolean;
  comparedSourceRows: number;
  comparedTargetRows: number;
  /** The last key both streams were advanced past; where a resumed run starts. */
  comparedThroughKey: string | null;
  rowLimit: number;
  sampleLimit: number;
  missingInTarget: DomainDriftBucket;
  missingInSource: DomainDriftBucket;
  fingerprintMismatch: DomainDriftBucket;
  /**
   * For the sampled D1-only rows of a user-scoped domain: how many of those
   * accounts already have a deletion tombstone in D1. A high count means the
   * extra rows are deleted accounts the sweep never removed from the mirror,
   * not rows Supabase lost.
   */
  deletionTombstones: { sampled: number; withTombstone: number } | null;
  /** Which side could not be read. Never carries a database message. */
  unavailable: "source" | "target" | null;
}

export interface CloudflareDomainDriftReport {
  generatedAt: string;
  rowLimit: number;
  sampleLimit: number;
  domains: CloudflareDomainDrift[];
}

interface DriftRow {
  key: string;
  fingerprint: string;
}

interface SourceDriftRow {
  row_key: string;
  fingerprint: string;
}

function field(value: string | number | null): string {
  if (value === null) return "-:";
  const text = String(value);
  return `${new TextEncoder().encode(text).byteLength}:${text}`;
}

function line(parts: Array<string | number | null>): string {
  return parts.map(field).join("|");
}

function clock(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return canonicalCloudflareSourceClock(value).replace(/\.(\d{6})\d{3}Z$/, ".$1Z");
  } catch {
    return null;
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface DomainSpec {
  /** Ordered, keyset-paged page of the domain. Parameters are (after, limit). */
  sql: string;
  /** The same evidence line the whole-domain fingerprint hashes for this row. */
  evidence: (row: Record<string, unknown>) => string;
  /** The account a D1 row belongs to, where the domain is user-scoped. */
  userId: ((row: Record<string, unknown>) => string) | null;
}

/*
  The key of every domain, and the order both sides are read in.

  The key must exist on both sides and must not be personal data: an account
  id, a store key, a provider event id, or the username, which is public and is
  the thing that has to be named when a sign-in alias resolves to the wrong
  account.

  `usernames.username` is a NOCASE column in D1 and would otherwise sort and
  compare case-insensitively, which would not line up with the source ordering
  and would hide a pair of rows that differ only in case. Every use of it here
  is therefore forced to BINARY.
*/
const SPECS: Record<DriftDomain, DomainSpec> = {
  profiles: {
    sql: `
      SELECT p.user_id AS drift_key, p.user_id, u.email, u.role,
             p.display_name, p.birth_date, p.account_kind
        FROM learner_profiles p JOIN app_users u ON u.id = p.user_id
       WHERE u.deleted_at IS NULL AND p.user_id > ?
       ORDER BY p.user_id LIMIT ?
    `,
    evidence: (row) => line([
      row.user_id as string,
      row.email as string | null,
      row.role as string,
      row.display_name as string | null,
      row.birth_date as string | null,
      row.account_kind as string | null,
    ]),
    userId: (row) => row.user_id as string,
  },
  usernames: {
    sql: `
      SELECT n.username AS drift_key, n.user_id, n.username
        FROM usernames n JOIN app_users u ON u.id = n.user_id
       WHERE u.deleted_at IS NULL AND n.username COLLATE BINARY > ?
       ORDER BY n.username COLLATE BINARY LIMIT ?
    `,
    evidence: (row) => line([row.user_id as string, row.username as string]),
    userId: (row) => row.user_id as string,
  },
  progress_snapshots: {
    sql: `
      SELECT s.user_id || '/' || s.store_key AS drift_key,
             s.user_id, s.store_key, s.source_updated_at AS updated_at
        FROM progress_snapshots s JOIN app_users u ON u.id = s.user_id
       WHERE u.deleted_at IS NULL AND s.user_id || '/' || s.store_key > ?
       ORDER BY drift_key LIMIT ?
    `,
    evidence: (row) => line([
      row.user_id as string,
      row.store_key as string,
      clock(row.updated_at),
    ]),
    userId: (row) => row.user_id as string,
  },
  subscriptions: {
    sql: `
      SELECT id AS drift_key, id, user_id, provider, status, tier,
             external_customer_id, external_subscription_id,
             original_transaction_id, external_price_id, current_period_end,
             cancel_at_period_end, provider_event_at, verified_at,
             created_at, updated_at
        FROM subscriptions WHERE id > ? ORDER BY id LIMIT ?
    `,
    evidence: (row) => line([
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
    ]),
    userId: (row) => row.user_id as string,
  },
  provider_events: {
    sql: `
      SELECT provider || '/' || event_id AS drift_key, provider, event_id
        FROM provider_events WHERE provider || '/' || event_id > ?
       ORDER BY drift_key LIMIT ?
    `,
    evidence: (row) => line([row.provider as string, row.event_id as string]),
    userId: null,
  },
  usage_events: {
    sql: `
      SELECT id AS drift_key, id, user_id, route, ip_hash, outcome, created_at
        FROM usage_events WHERE id > ? ORDER BY id LIMIT ?
    `,
    evidence: (row) => line([
      row.id as string,
      row.user_id as string | null,
      row.route as string,
      row.ip_hash as string | null,
      row.outcome as string,
      clock(row.created_at),
    ]),
    userId: (row) => (row.user_id as string | null) ?? "",
  },
  ai_cost_events: {
    sql: `
      SELECT id AS drift_key, id, source, provider_request_id, external_reference,
             route, model, input_tokens, output_tokens,
             cache_creation_input_tokens, cache_creation_5m_input_tokens,
             cache_creation_1h_input_tokens, cache_read_input_tokens,
             cost_usd, occurred_at, recorded_at
        FROM ai_cost_events WHERE id > ? ORDER BY id LIMIT ?
    `,
    evidence: (row) => line([
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
    ]),
    userId: null,
  },
  ai_cost_coverage: {
    sql: `
      -- The one row's key is a constant on both sides: D1 stores the marker as
      -- the integer 1 and Postgres as the boolean true, so neither spelling
      -- can be the shared key.
      SELECT 'singleton' AS drift_key,
             source, starts_at, historical_complete, recorded_at
        FROM ai_cost_coverage WHERE 'singleton' > ?
       ORDER BY drift_key LIMIT ?
    `,
    evidence: (row) => line([
      "true",
      row.source as string,
      clock(row.starts_at),
      Number(row.historical_complete) === 1 ? "true" : "false",
      clock(row.recorded_at),
    ]),
    userId: null,
  },
};

/**
 * One page of the D1 side, as (key, evidence line) before hashing.
 *
 * The unhashed line is kept here so a test can rebuild the whole-domain
 * fingerprint from it and prove this module and `migration-readiness.ts`
 * describe the same rows in the same way.
 */
export async function cloudflareTargetDriftPage(
  domain: DriftDomain,
  bindings: BandUpCloudflareBindings,
  after: string,
  limit: number,
): Promise<Array<{ key: string; evidence: string; userId: string | null }>> {
  const spec = SPECS[domain];
  const { results } = await bindings.db.prepare(spec.sql).bind(after, limit).all();
  return (results as Record<string, unknown>[]).map((row) => ({
    key: String(row.drift_key),
    evidence: spec.evidence(row),
    userId: spec.userId ? spec.userId(row) || null : null,
  }));
}

/*
  Byte order, on both sides and here.

  Postgres is asked for `collate "C"`, SQLite compares TEXT as bytes, and
  JavaScript compares UTF-16 code units. The three agree for every key shape
  this compares — hex ids, usernames, store keys and provider event ids are
  ASCII — and the merge join depends on that agreement, so the comparison is
  written once, here, rather than left implicit at each call site.
*/
function compareKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

type ReadPage = (after: string, limit: number) => Promise<DriftRow[]>;

class Stream {
  private buffer: DriftRow[] = [];
  private index = 0;
  private after = "";
  private exhausted = false;
  consumed = 0;
  private readonly read: ReadPage;

  constructor(read: ReadPage) {
    this.read = read;
  }

  async peek(): Promise<DriftRow | null> {
    if (this.index < this.buffer.length) return this.buffer[this.index];
    if (this.exhausted) return null;
    const page = await this.read(this.after, PAGE_SIZE);
    if (page.length === 0) {
      this.exhausted = true;
      return null;
    }
    if (page.length < PAGE_SIZE) this.exhausted = true;
    this.buffer = page;
    this.index = 0;
    this.after = page[page.length - 1].key;
    return this.buffer[0];
  }

  advance(): void {
    this.index += 1;
    this.consumed += 1;
  }
}

function bucket(sampleLimit: number) {
  const sample: string[] = [];
  let total = 0;
  return {
    add(key: string) {
      total += 1;
      if (sample.length < sampleLimit) sample.push(key);
    },
    get value(): DomainDriftBucket {
      return { total, sample: [...sample] };
    },
  };
}

async function tombstoneCount(
  bindings: BandUpCloudflareBindings,
  userIds: string[],
): Promise<{ sampled: number; withTombstone: number }> {
  const unique = [...new Set(userIds.filter((id) => id.length > 0))];
  if (unique.length === 0) return { sampled: 0, withTombstone: 0 };
  const placeholders = unique.map(() => "?").join(",");
  const row = await bindings.db.prepare(
    `SELECT COUNT(*) AS n FROM account_deletion_tombstones WHERE user_id IN (${placeholders})`,
  ).bind(...unique).first<{ n: number }>();
  return { sampled: unique.length, withTombstone: Number(row?.n ?? 0) };
}

export interface DomainDriftOptions {
  rowLimit?: number;
  sampleLimit?: number;
  /** Injected by tests; production reads the restricted Supabase RPC. */
  readSourcePage?: (domain: DriftDomain, after: string, limit: number) => Promise<SourceDriftRow[]>;
}

function readSource(
  domain: DriftDomain,
  override: DomainDriftOptions["readSourcePage"],
): ReadPage {
  return async (after, limit) => {
    const rows = override
      ? await override(domain, after, limit)
      : await rpc<SourceDriftRow[]>("cloudflare_migration_source_row_fingerprints", {
        p_domain: domain,
        p_after: after,
        p_limit: limit,
      });
    if (!Array.isArray(rows)) throw new Error("source page is not a list");
    return rows.map((row) => {
      if (typeof row?.row_key !== "string" || !/^[a-f0-9]{64}$/.test(row?.fingerprint ?? "")) {
        throw new Error("source page is malformed");
      }
      return { key: row.row_key, fingerprint: row.fingerprint };
    });
  };
}

function readTarget(domain: DriftDomain, bindings: BandUpCloudflareBindings): {
  page: ReadPage;
  userIdOf: Map<string, string>;
} {
  const userIdOf = new Map<string, string>();
  return {
    userIdOf,
    page: async (after, limit) => {
      const rows = await cloudflareTargetDriftPage(domain, bindings, after, limit);
      return Promise.all(rows.map(async (row) => {
        if (row.userId) userIdOf.set(row.key, row.userId);
        return { key: row.key, fingerprint: await sha256(row.evidence) };
      }));
    },
  };
}

/** Diffs one domain row by row. Read-only on both sides. */
export async function cloudflareDomainDrift(
  domain: DriftDomain,
  bindings: BandUpCloudflareBindings,
  options: DomainDriftOptions = {},
): Promise<CloudflareDomainDrift> {
  const rowLimit = Math.max(1, Math.min(options.rowLimit ?? DEFAULT_DRIFT_ROW_LIMIT, 200000));
  const sampleLimit = Math.max(1, Math.min(options.sampleLimit ?? DEFAULT_DRIFT_SAMPLE_LIMIT, 200));
  const missingInTarget = bucket(sampleLimit);
  const missingInSource = bucket(sampleLimit);
  const fingerprintMismatch = bucket(sampleLimit);
  const target = readTarget(domain, bindings);
  const source = new Stream(readSource(domain, options.readSourcePage));
  const targetStream = new Stream(target.page);

  const base = {
    domain,
    rowLimit,
    sampleLimit,
    comparedSourceRows: 0,
    comparedTargetRows: 0,
    comparedThroughKey: null as string | null,
    complete: false,
    missingInTarget: missingInTarget.value,
    missingInSource: missingInSource.value,
    fingerprintMismatch: fingerprintMismatch.value,
    deletionTombstones: null,
  };

  let complete = true;
  let comparedThroughKey: string | null = null;
  let side: "source" | "target" = "source";
  try {
    for (;;) {
      if (Math.max(source.consumed, targetStream.consumed) >= rowLimit) {
        complete = false;
        break;
      }
      side = "source";
      const left = await source.peek();
      side = "target";
      const right = await targetStream.peek();
      if (!left && !right) break;
      if (right === null || (left !== null && compareKeys(left.key, right.key) < 0)) {
        missingInTarget.add(left!.key);
        comparedThroughKey = left!.key;
        source.advance();
        continue;
      }
      if (left === null || compareKeys(left.key, right.key) > 0) {
        missingInSource.add(right.key);
        comparedThroughKey = right.key;
        targetStream.advance();
        continue;
      }
      if (left.fingerprint !== right.fingerprint) fingerprintMismatch.add(left.key);
      comparedThroughKey = left.key;
      source.advance();
      targetStream.advance();
    }
  } catch {
    // Neither a Supabase nor a D1 error body may reach the caller; the report
    // says which side failed and nothing more.
    return { ...base, status: "unavailable", unavailable: side };
  }

  const extraKeys = missingInSource.value.sample;
  let deletionTombstones: CloudflareDomainDrift["deletionTombstones"] = null;
  if (SPECS[domain].userId && extraKeys.length > 0) {
    deletionTombstones = await tombstoneCount(
      bindings,
      extraKeys.map((key) => target.userIdOf.get(key) ?? ""),
    ).catch(() => null);
  }

  const drifted = missingInTarget.value.total + missingInSource.value.total
    + fingerprintMismatch.value.total;
  return {
    ...base,
    complete,
    comparedSourceRows: source.consumed,
    comparedTargetRows: targetStream.consumed,
    comparedThroughKey,
    missingInTarget: missingInTarget.value,
    missingInSource: missingInSource.value,
    fingerprintMismatch: fingerprintMismatch.value,
    deletionTombstones,
    // No drift found in a comparison that stopped early proves nothing about
    // the rest of the domain, so it is not allowed to say "equal".
    status: drifted > 0 ? "drifted" : complete ? "equal" : "partial",
    unavailable: null,
  };
}

/** Diffs the requested domains, or all of them. */
export async function cloudflareDomainDriftReport(
  bindings: BandUpCloudflareBindings,
  domains: readonly DriftDomain[] = DRIFT_DOMAINS,
  options: DomainDriftOptions = {},
): Promise<CloudflareDomainDriftReport> {
  const wanted = domains.length > 0 ? domains : DRIFT_DOMAINS;
  const results: CloudflareDomainDrift[] = [];
  // Sequential on purpose: eight concurrent paged scans would multiply the
  // load this puts on a live Supabase and a live D1 by eight.
  for (const domain of wanted) {
    results.push(await cloudflareDomainDrift(domain, bindings, options));
  }
  return {
    generatedAt: new Date().toISOString(),
    rowLimit: results[0]?.rowLimit ?? DEFAULT_DRIFT_ROW_LIMIT,
    sampleLimit: results[0]?.sampleLimit ?? DEFAULT_DRIFT_SAMPLE_LIMIT,
    domains: results,
  };
}

/** Parses the `drift` query parameter: `1`/`all`, or a comma-separated list. */
export function parseDriftDomains(value: string | null): DriftDomain[] | null {
  if (value === null || value === "" || value === "0" || value === "false") return null;
  if (value === "1" || value === "true" || value === "all") return [...DRIFT_DOMAINS];
  const known = new Set<string>(DRIFT_DOMAINS);
  const wanted = value.split(",").map((part) => part.trim()).filter((part) => known.has(part));
  return wanted.length > 0 ? wanted as DriftDomain[] : null;
}
