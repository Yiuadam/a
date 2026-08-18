import { rpc } from "@/lib/auth/supabase";
import type { BandUpCloudflareBindings } from "./bindings";
import { canonicalPayloadHash } from "./payload-canonical";

/*
  Proves the payload bytes match, not just the row.

  migration-readiness.ts and domain-drift.ts compare progress_snapshots,
  subscriptions and provider_events on identity columns only — user_id /
  store_key / source_updated_at, id, provider / event_id. The payload column
  itself is never opened, so D1 can hold a stale or corrupt copy of a
  learner's entire record — every essay, every mock report, every drill
  score — and both reports still say `equal`. This module opens the payload
  on both sides, canonicalises it the one way defined in
  lib/cloudflare/payload-canonical.ts, and compares hashes.

  Same shape as domain-drift.ts, deliberately: a keyset-paged, merge-joined
  scan of both sides, bounded by rowLimit, sampling at most sampleLimit keys
  per bucket, reporting `complete: false` rather than a clean "equal" the
  moment the bound is hit. It is not the same code, because the unit being
  compared is different in a way that matters:

    - domain-drift hashes a row's identity columns, read directly off each
      side's table in one query per page.
    - this hashes a JSON payload, which on the D1 side may be `payload_bytes`
      inline in the row or a separate R2 object the row only points to. A row
      whose R2 object is missing or fails its own checksum is worse than a
      missing row — the row *looks* present and correct until someone tries
      to read it — so that case is its own bucket, `targetPayloadUnavailable`,
      never folded into "equal" and never silently skipped.

  Cost: hashing a payload means reading it, and an R2 read costs more than a
  D1 row read. rowLimit exists for the same reason it exists in
  domain-drift.ts — a live comparison must say how far it got rather than
  imply it read everything — but the default here is smaller, because a
  domain with many out-of-line payloads (progress snapshots are the one this
  matters for; a mock-test transcript is easily over the 96 KB inline limit)
  turns every page into an R2 round trip.
*/

export const PAYLOAD_PARITY_DOMAINS = ["progress_snapshots", "subscriptions", "provider_events"] as const;
export type PayloadParityDomain = typeof PAYLOAD_PARITY_DOMAINS[number];

export const DEFAULT_PAYLOAD_PARITY_ROW_LIMIT = 2000;
export const DEFAULT_PAYLOAD_PARITY_SAMPLE_LIMIT = 20;
const PAGE_SIZE = 100;

export interface PayloadParityBucket {
  total: number;
  sample: string[];
}

export interface CloudflarePayloadParity {
  domain: PayloadParityDomain;
  status: "equal" | "drifted" | "partial" | "unavailable";
  complete: boolean;
  comparedSourceRows: number;
  comparedTargetRows: number;
  comparedThroughKey: string | null;
  rowLimit: number;
  sampleLimit: number;
  /** A row Supabase has and the D1 mirror does not. */
  missingInTarget: PayloadParityBucket;
  /** A row the D1 mirror has and Supabase does not. */
  missingInSource: PayloadParityBucket;
  /** Both sides have the row and a payload, and the canonical hashes differ. */
  payloadMismatch: PayloadParityBucket;
  /**
   * Both sides have the row, but D1's stored payload could not be read back:
   * the R2 object it points to is missing, or its bytes fail their own
   * sha256/length check. A row in this state is worse than a missing row —
   * it reads as present until a learner actually opens it — so it is never
   * folded into `equal` or `missingInTarget`.
   */
  targetPayloadUnavailable: PayloadParityBucket;
  unavailable: "source" | "target" | null;
}

export interface CloudflarePayloadParityReport {
  generatedAt: string;
  rowLimit: number;
  sampleLimit: number;
  domains: CloudflarePayloadParity[];
}

interface SourcePayloadRow {
  row_key: string;
  payload_present: boolean;
  payload_hash: string | null;
}

interface ParityRow {
  key: string;
  present: boolean;
  hash: string | null;
  /** Target-only: this row's payload could not be read back at all (see readTargetPayload). */
  failed?: boolean;
}

interface TargetPayloadColumns {
  inline: string | null;
  objectKey: string | null;
  sha256: string | null;
  bytes: number | null;
}

interface DomainSpec {
  /** Ordered, keyset-paged page of the domain. Parameters are (after, limit). */
  sql: string;
  columns: (row: Record<string, unknown>) => TargetPayloadColumns;
}

const SPECS: Record<PayloadParityDomain, DomainSpec> = {
  progress_snapshots: {
    sql: `
      SELECT s.user_id || '/' || s.store_key AS drift_key,
             s.payload_inline, s.payload_object_key, s.payload_sha256, s.payload_bytes
        FROM progress_snapshots s JOIN app_users u ON u.id = s.user_id
       WHERE u.deleted_at IS NULL AND s.user_id || '/' || s.store_key > ?
       ORDER BY drift_key LIMIT ?
    `,
    columns: (row) => ({
      inline: row.payload_inline as string | null,
      objectKey: row.payload_object_key as string | null,
      sha256: row.payload_sha256 as string,
      bytes: row.payload_bytes as number,
    }),
  },
  subscriptions: {
    sql: `
      SELECT id AS drift_key, raw_inline, raw_object_key, raw_sha256
        FROM subscriptions WHERE id > ? ORDER BY id LIMIT ?
    `,
    columns: (row) => ({
      inline: row.raw_inline as string | null,
      objectKey: row.raw_object_key as string | null,
      sha256: row.raw_sha256 as string | null,
      // subscriptions carries no byte count column; the R2 object's own
      // length stands in for it (see readTargetPayload below).
      bytes: null,
    }),
  },
  provider_events: {
    sql: `
      SELECT provider || '/' || event_id AS drift_key, payload_object_key, payload_sha256
        FROM provider_events WHERE provider || '/' || event_id > ?
       ORDER BY drift_key LIMIT ?
    `,
    columns: (row) => ({
      inline: null,
      objectKey: row.payload_object_key as string | null,
      sha256: row.payload_sha256 as string | null,
      bytes: null,
    }),
  },
};

function bucket(sampleLimit: number) {
  const sample: string[] = [];
  let total = 0;
  return {
    add(key: string) {
      total += 1;
      if (sample.length < sampleLimit) sample.push(key);
    },
    get value(): PayloadParityBucket {
      return { total, sample: [...sample] };
    },
  };
}

/**
 * Reads one D1 row's payload back the way readStoredJson does — inline text,
 * or an R2 object verified against its own recorded sha256/length — except a
 * missing object or a failed check is returned as a distinct outcome rather
 * than thrown, so one bad row does not abort the whole page.
 */
async function readTargetPayload(
  bindings: BandUpCloudflareBindings,
  columns: TargetPayloadColumns,
): Promise<{ present: boolean; hash: string | null } | "unavailable"> {
  if (columns.inline !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(columns.inline);
    } catch {
      return "unavailable";
    }
    return { present: true, hash: await canonicalPayloadHash(parsed) };
  }
  if (columns.objectKey === null) {
    // Neither inline text nor an object key: no payload was ever stored for
    // this row (legacy subscriptions/provider_events rows predate payload
    // replication). Distinct from a missing R2 object.
    return { present: false, hash: null };
  }
  let object: Awaited<ReturnType<BandUpCloudflareBindings["files"]["get"]>>;
  try {
    object = await bindings.files.get(columns.objectKey);
  } catch {
    return "unavailable";
  }
  if (!object) return "unavailable";
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await object.arrayBuffer());
  } catch {
    return "unavailable";
  }
  if (columns.bytes !== null && bytes.byteLength !== columns.bytes) return "unavailable";
  const digest = await sha256Hex(bytes);
  if (columns.sha256 !== null && digest !== columns.sha256) return "unavailable";
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return "unavailable";
  }
  return { present: true, hash: await canonicalPayloadHash(parsed) };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const owned = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest("SHA-256", owned.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/*
  Byte order, on both sides and here — same reasoning as domain-drift.ts:
  Postgres is asked for `collate "C"`, SQLite compares TEXT as bytes, and
  JavaScript compares UTF-16 code units. All three agree for the ASCII key
  shapes these domains use (account ids, store keys, provider event ids).
*/
function compareKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

type ReadPage<T> = (after: string, limit: number) => Promise<T[]>;

class Stream<T extends { key: string }> {
  private buffer: T[] = [];
  private index = 0;
  private after = "";
  private exhausted = false;
  consumed = 0;
  private readonly read: ReadPage<T>;

  constructor(read: ReadPage<T>) {
    this.read = read;
  }

  async peek(): Promise<T | null> {
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

export interface PayloadParityOptions {
  rowLimit?: number;
  sampleLimit?: number;
  /** Injected by tests; production reads the restricted Supabase RPC. */
  readSourcePage?: (domain: PayloadParityDomain, after: string, limit: number) => Promise<SourcePayloadRow[]>;
}

function readSource(
  domain: PayloadParityDomain,
  override: PayloadParityOptions["readSourcePage"],
): ReadPage<ParityRow> {
  return async (after, limit) => {
    const rows = override
      ? await override(domain, after, limit)
      : await rpc<SourcePayloadRow[]>("cloudflare_migration_source_payload_fingerprints", {
        p_domain: domain,
        p_after: after,
        p_limit: limit,
      });
    if (!Array.isArray(rows)) throw new Error("source page is not a list");
    return rows.map((row) => {
      if (typeof row?.row_key !== "string" || typeof row?.payload_present !== "boolean") {
        throw new Error("source page is malformed");
      }
      if (row.payload_present && !/^[a-f0-9]{64}$/.test(row.payload_hash ?? "")) {
        throw new Error("source page is malformed");
      }
      return { key: row.row_key, present: row.payload_present, hash: row.payload_present ? row.payload_hash : null };
    });
  };
}

function readTarget(
  domain: PayloadParityDomain,
  bindings: BandUpCloudflareBindings,
  onUnavailable: (key: string) => void,
): ReadPage<ParityRow> {
  const spec = SPECS[domain];
  return async (after, limit) => {
    const { results } = await bindings.db.prepare(spec.sql).bind(after, limit).all();
    const rows: ParityRow[] = [];
    for (const raw of results as Record<string, unknown>[]) {
      const key = String(raw.drift_key);
      const outcome = await readTargetPayload(bindings, spec.columns(raw));
      if (outcome === "unavailable") {
        onUnavailable(key);
        // Still occupies a slot in the merge join — it is a real row that
        // was compared and found wanting, not one to be treated as absent.
        rows.push({ key, present: true, hash: null, failed: true });
        continue;
      }
      rows.push({ key, present: outcome.present, hash: outcome.hash });
    }
    return rows;
  };
}

/** Diffs one domain's payload column, row by row. Read-only on both sides. */
export async function cloudflarePayloadParity(
  domain: PayloadParityDomain,
  bindings: BandUpCloudflareBindings,
  options: PayloadParityOptions = {},
): Promise<CloudflarePayloadParity> {
  const rowLimit = Math.max(1, Math.min(options.rowLimit ?? DEFAULT_PAYLOAD_PARITY_ROW_LIMIT, 50000));
  const sampleLimit = Math.max(1, Math.min(options.sampleLimit ?? DEFAULT_PAYLOAD_PARITY_SAMPLE_LIMIT, 200));
  const missingInTarget = bucket(sampleLimit);
  const missingInSource = bucket(sampleLimit);
  const payloadMismatch = bucket(sampleLimit);
  const targetPayloadUnavailable = bucket(sampleLimit);

  const source = new Stream(readSource(domain, options.readSourcePage));
  const target = new Stream(readTarget(domain, bindings, (key) => targetPayloadUnavailable.add(key)));

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
    payloadMismatch: payloadMismatch.value,
    targetPayloadUnavailable: targetPayloadUnavailable.value,
  };

  let complete = true;
  let comparedThroughKey: string | null = null;
  let side: "source" | "target" = "source";
  try {
    for (;;) {
      if (Math.max(source.consumed, target.consumed) >= rowLimit) {
        complete = false;
        break;
      }
      side = "source";
      const left = await source.peek();
      side = "target";
      const right = await target.peek();
      if (!left && !right) break;
      if (right === null || (left !== null && compareKeys(left.key, right.key) < 0)) {
        // A row Supabase has that D1 never received, unless Supabase itself
        // holds no payload for it either (a legacy row) — that is not a
        // mirroring gap.
        if (left!.present) missingInTarget.add(left!.key);
        comparedThroughKey = left!.key;
        source.advance();
        continue;
      }
      if (left === null || compareKeys(left.key, right.key) > 0) {
        if (right.present) missingInSource.add(right.key);
        comparedThroughKey = right.key;
        target.advance();
        continue;
      }
      // Both sides have the row. A target read that failed its own checksum
      // was already recorded in targetPayloadUnavailable by readTarget; it
      // must not also count as a plain hash mismatch.
      if (!right.failed) {
        if (left.present !== right.present || (left.present && left.hash !== right.hash)) {
          payloadMismatch.add(left.key);
        }
      }
      comparedThroughKey = left.key;
      source.advance();
      target.advance();
    }
  } catch {
    // Neither a Supabase nor a D1/R2 error body may reach the caller; the
    // report says which side failed and nothing more.
    return { ...base, status: "unavailable", unavailable: side };
  }

  const drifted = missingInTarget.value.total + missingInSource.value.total
    + payloadMismatch.value.total + targetPayloadUnavailable.value.total;
  return {
    ...base,
    complete,
    comparedSourceRows: source.consumed,
    comparedTargetRows: target.consumed,
    comparedThroughKey,
    missingInTarget: missingInTarget.value,
    missingInSource: missingInSource.value,
    payloadMismatch: payloadMismatch.value,
    targetPayloadUnavailable: targetPayloadUnavailable.value,
    // No drift found in a comparison that stopped early proves nothing about
    // the rest of the domain, so it is not allowed to say "equal".
    status: drifted > 0 ? "drifted" : complete ? "equal" : "partial",
    unavailable: null,
  };
}

/** Diffs the requested domains, or all of them. */
export async function cloudflarePayloadParityReport(
  bindings: BandUpCloudflareBindings,
  domains: readonly PayloadParityDomain[] = PAYLOAD_PARITY_DOMAINS,
  options: PayloadParityOptions = {},
): Promise<CloudflarePayloadParityReport> {
  const wanted = domains.length > 0 ? domains : PAYLOAD_PARITY_DOMAINS;
  const results: CloudflarePayloadParity[] = [];
  // Sequential on purpose: concurrent paged scans across these domains would
  // multiply the R2 read load this puts on a live bucket.
  for (const domain of wanted) {
    results.push(await cloudflarePayloadParity(domain, bindings, options));
  }
  return {
    generatedAt: new Date().toISOString(),
    rowLimit: results[0]?.rowLimit ?? DEFAULT_PAYLOAD_PARITY_ROW_LIMIT,
    sampleLimit: results[0]?.sampleLimit ?? DEFAULT_PAYLOAD_PARITY_SAMPLE_LIMIT,
    domains: results,
  };
}

/** Parses the `payloadParity` query parameter: `1`/`all`, or a comma-separated list. */
export function parsePayloadParityDomains(value: string | null): PayloadParityDomain[] | null {
  if (value === null || value === "" || value === "0" || value === "false") return null;
  if (value === "1" || value === "true" || value === "all") return [...PAYLOAD_PARITY_DOMAINS];
  const known = new Set<string>(PAYLOAD_PARITY_DOMAINS);
  const wanted = value.split(",").map((part) => part.trim()).filter((part) => known.has(part));
  return wanted.length > 0 ? wanted as PayloadParityDomain[] : null;
}
