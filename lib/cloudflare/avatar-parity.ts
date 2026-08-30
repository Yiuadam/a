import type { BandUpCloudflareBindings } from "./bindings";
import { sha256 } from "./payloads";
import {
  avatarPathPage,
  downloadAvatarBytes,
  type AvatarPathRow,
} from "@/lib/auth/supabase";

/*
  Whether the profile pictures said to exist in R2 are the same bytes as the
  ones in Supabase Storage, and — the part that actually blocks a read
  cutover — how many learners have a picture in Supabase today that D1 has no
  pointer to at all.

  A read cutover serves avatars from D1's `avatar_object_key`. A profile whose
  Supabase `avatar_path` is set but whose D1 `avatar_object_key` is null is a
  face that would vanish the moment reads move, with nothing already in this
  codebase saying so: migration-readiness.ts's `profiles` fingerprint never
  read `avatar_object_key`, so an otherwise-equal profile row proves nothing
  about whether its picture would survive a cutover.

  Two costs are kept apart on purpose, and bounded separately.

  Naming which users have a picture recorded on one side and not the other is
  cheap — one paged text column from each store, merge-joined the same way
  domain-drift.ts compares every other domain — so that half of this report
  walks both stores exhaustively up to `rowLimit`.

  Proving the bytes actually match is not cheap: it means downloading the
  object from both Supabase Storage and R2 and hashing what came back, for
  every user who has one on both sides. That is bounded much more tightly by
  `byteCheckLimit`, see its default below for the reasoning.

  Nothing personal crosses into the report. Every bucket samples user ids —
  the same key domain-drift.ts already treats as safe to name — and never an
  avatar path, an object key or an image byte.
*/

export const DEFAULT_AVATAR_PARITY_ROW_LIMIT = 20000;
export const MAX_AVATAR_PARITY_ROW_LIMIT = 200000;
export const DEFAULT_AVATAR_PARITY_SAMPLE_LIMIT = 20;
export const MAX_AVATAR_PARITY_SAMPLE_LIMIT = 200;
/*
  Every byte check is two network reads (Supabase Storage, then R2) plus two
  SHA-256 hashes, all inside one admin request that still has to return before
  the Worker's own execution limit. `scripts/migrate-supabase-to-cloudflare.mjs`
  allows an avatar up to 10MB, far larger than anything the app itself has
  written since the upload route started shrinking pictures to a 128KB
  ceiling — so 25 is sized for the slow, historical case rather than the
  small, current one, and still returns comfortably inside one request. An
  owner who wants a deeper sweep raises it page by page with
  `?avatarParityBytes=`, which resumes from `comparedThroughKey` rather than
  re-checking what a previous call already verified.
*/
export const DEFAULT_AVATAR_PARITY_BYTE_LIMIT = 25;
export const MAX_AVATAR_PARITY_BYTE_LIMIT = 250;
const PAGE_SIZE = 500;

export type AvatarByteStatus =
  | "equal"
  | "different"
  | "source_unreadable"
  | "target_unreadable"
  | "both_unreadable";

export interface AvatarParityBucket {
  /** Rows found in the part of the comparison that was actually run. */
  total: number;
  /** At most `sampleLimit` user ids, in comparison order. */
  sample: string[];
}

export interface AvatarObjectParityReport {
  generatedAt: string;
  status: "equal" | "drifted" | "partial" | "unavailable";
  /** False when either the presence scan or the byte budget stopped early. */
  complete: boolean;
  presenceComplete: boolean;
  bytesComplete: boolean;
  rowLimit: number;
  sampleLimit: number;
  byteCheckLimit: number;
  comparedSourceRows: number;
  comparedTargetRows: number;
  /** The last key both streams were advanced past; where a resumed run starts. */
  comparedThroughKey: string | null;
  /**
   * Supabase has `avatar_path`, D1's `avatar_object_key` is null. The count
   * that has to be zero before any read cutover — every one of these is a
   * learner who has a picture today and would have none the moment reads
   * move to D1.
   */
  disappearingFaces: AvatarParityBucket;
  /** D1 has an object key Supabase's avatar_path does not name. Reported, never fixed from here. */
  targetOnly: AvatarParityBucket;
  bytes: {
    checked: number;
    /** Matched pairs found within `rowLimit` but past `byteCheckLimit`. */
    skipped: number;
    equal: AvatarParityBucket;
    different: AvatarParityBucket;
    /** Supabase Storage object missing or unreadable for a row that names it. */
    sourceUnreadable: AvatarParityBucket;
    /**
     * R2 object missing or unreadable for a row D1 says exists. Worse than
     * `disappearingFaces`: the app will still try to serve this one and fail,
     * rather than simply having nothing to show.
     */
    targetUnreadable: AvatarParityBucket;
    bothUnreadable: AvatarParityBucket;
  };
  /** Which side could not be read at all. Never carries a database message. */
  unavailable: "source" | "target" | null;
}

function bucket(sampleLimit: number) {
  const sample: string[] = [];
  let total = 0;
  return {
    add(key: string) {
      total += 1;
      if (sample.length < sampleLimit) sample.push(key);
    },
    get value(): AvatarParityBucket {
      return { total, sample: [...sample] };
    },
  };
}

interface KeyedRow {
  key: string;
}

type ReadPage<T extends KeyedRow> = (after: string, limit: number) => Promise<T[]>;

/** Ordered, keyset-paged stream over one side. Buffers one page at a time. */
class Stream<T extends KeyedRow> {
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

/**
 * One page of the D1 side: every non-deleted, non-tombstoned learner whose
 * `avatar_object_key` is set, ordered by `user_id`.
 */
export async function cloudflareAvatarTargetPage(
  bindings: BandUpCloudflareBindings,
  after: string,
  limit: number,
): Promise<Array<{ userId: string; avatarObjectKey: string }>> {
  const { results } = await bindings.db.prepare(`
    SELECT p.user_id AS user_id, p.avatar_object_key AS avatar_object_key
      FROM learner_profiles p JOIN app_users u ON u.id = p.user_id
     WHERE u.deleted_at IS NULL AND p.avatar_object_key IS NOT NULL AND p.user_id > ?
       AND NOT EXISTS (
         SELECT 1 FROM account_deletion_tombstones d WHERE d.user_id = p.user_id
       )
     ORDER BY p.user_id LIMIT ?
  `).bind(after, limit).all();
  return (results as Record<string, unknown>[]).map((row) => ({
    userId: String(row.user_id),
    avatarObjectKey: String(row.avatar_object_key),
  }));
}

/**
 * Downloads one avatar from both stores and hashes what came back. Never
 * throws: a network failure, a missing object or a read error on either side
 * becomes one of the four unreadable/equal/different outcomes, not an
 * exception — this runs inside a merge join that must keep going past one
 * bad object.
 */
async function compareBytes(
  userId: string,
  avatarPath: string,
  avatarObjectKey: string,
  bindings: BandUpCloudflareBindings,
  readSourceBytes: (userId: string, path: string) => Promise<Uint8Array | null>,
): Promise<AvatarByteStatus> {
  const [sourceResult, targetResult] = await Promise.allSettled([
    readSourceBytes(userId, avatarPath),
    bindings.files.get(avatarObjectKey),
  ]);
  const sourceBytes = sourceResult.status === "fulfilled" ? sourceResult.value : null;
  let targetBytes: Uint8Array | null = null;
  if (targetResult.status === "fulfilled" && targetResult.value) {
    try {
      targetBytes = new Uint8Array(await targetResult.value.arrayBuffer());
    } catch {
      targetBytes = null;
    }
  }
  if (!sourceBytes && !targetBytes) return "both_unreadable";
  if (!sourceBytes) return "source_unreadable";
  if (!targetBytes) return "target_unreadable";
  if (sourceBytes.length !== targetBytes.length) return "different";
  const [sourceDigest, targetDigest] = await Promise.all([sha256(sourceBytes), sha256(targetBytes)]);
  return sourceDigest === targetDigest ? "equal" : "different";
}

export interface AvatarObjectParityOptions {
  rowLimit?: number;
  sampleLimit?: number;
  byteCheckLimit?: number;
  /** Injected by tests; production pages Supabase profiles with a stored avatar. */
  readSourcePage?: (after: string, limit: number) => Promise<AvatarPathRow[]>;
  /** Injected by tests; production downloads the object straight from Supabase Storage. */
  readSourceBytes?: (userId: string, path: string) => Promise<Uint8Array | null>;
}

/** Diffs avatar presence exhaustively (up to `rowLimit`), and bytes for a bounded sample. Read-only on both sides. */
export async function avatarObjectParityReport(
  bindings: BandUpCloudflareBindings,
  options: AvatarObjectParityOptions = {},
): Promise<AvatarObjectParityReport> {
  const rowLimit = Math.max(
    1,
    Math.min(options.rowLimit ?? DEFAULT_AVATAR_PARITY_ROW_LIMIT, MAX_AVATAR_PARITY_ROW_LIMIT),
  );
  const sampleLimit = Math.max(
    1,
    Math.min(options.sampleLimit ?? DEFAULT_AVATAR_PARITY_SAMPLE_LIMIT, MAX_AVATAR_PARITY_SAMPLE_LIMIT),
  );
  const byteCheckLimit = Math.max(
    0,
    Math.min(options.byteCheckLimit ?? DEFAULT_AVATAR_PARITY_BYTE_LIMIT, MAX_AVATAR_PARITY_BYTE_LIMIT),
  );
  const readSourcePage = options.readSourcePage ?? avatarPathPage;
  const readSourceBytes = options.readSourceBytes ?? downloadAvatarBytes;

  const disappearingFaces = bucket(sampleLimit);
  const targetOnly = bucket(sampleLimit);
  const equalBucket = bucket(sampleLimit);
  const differentBucket = bucket(sampleLimit);
  const sourceUnreadable = bucket(sampleLimit);
  const targetUnreadable = bucket(sampleLimit);
  const bothUnreadable = bucket(sampleLimit);

  const source = new Stream<{ key: string; avatarPath: string }>(async (after, limit) => {
    const rows = await readSourcePage(after, limit);
    return rows.map((row) => ({ key: row.userId, avatarPath: row.avatarPath }));
  });
  const target = new Stream<{ key: string; avatarObjectKey: string }>(async (after, limit) => {
    const rows = await cloudflareAvatarTargetPage(bindings, after, limit);
    return rows.map((row) => ({ key: row.userId, avatarObjectKey: row.avatarObjectKey }));
  });

  const emptyBytes = {
    checked: 0,
    skipped: 0,
    equal: equalBucket.value,
    different: differentBucket.value,
    sourceUnreadable: sourceUnreadable.value,
    targetUnreadable: targetUnreadable.value,
    bothUnreadable: bothUnreadable.value,
  };
  const base = {
    generatedAt: new Date().toISOString(),
    rowLimit,
    sampleLimit,
    byteCheckLimit,
    comparedSourceRows: 0,
    comparedTargetRows: 0,
    comparedThroughKey: null as string | null,
    complete: false,
    presenceComplete: false,
    bytesComplete: false,
    disappearingFaces: disappearingFaces.value,
    targetOnly: targetOnly.value,
    bytes: emptyBytes,
  };

  let byteChecks = 0;
  let byteSkipped = 0;
  let presenceComplete = true;
  let comparedThroughKey: string | null = null;
  let side: "source" | "target" = "source";
  try {
    for (;;) {
      if (Math.max(source.consumed, target.consumed) >= rowLimit) {
        presenceComplete = false;
        break;
      }
      side = "source";
      const left = await source.peek();
      side = "target";
      const right = await target.peek();
      if (!left && !right) break;
      if (right === null || (left !== null && left.key < right.key)) {
        disappearingFaces.add(left!.key);
        comparedThroughKey = left!.key;
        source.advance();
        continue;
      }
      if (left === null || left.key > right.key) {
        targetOnly.add(right.key);
        comparedThroughKey = right.key;
        target.advance();
        continue;
      }
      comparedThroughKey = left.key;
      if (byteChecks < byteCheckLimit) {
        byteChecks += 1;
        const status = await compareBytes(
          left.key,
          left.avatarPath,
          right.avatarObjectKey,
          bindings,
          readSourceBytes,
        );
        if (status === "equal") equalBucket.add(left.key);
        else if (status === "different") differentBucket.add(left.key);
        else if (status === "source_unreadable") sourceUnreadable.add(left.key);
        else if (status === "target_unreadable") targetUnreadable.add(left.key);
        else bothUnreadable.add(left.key);
      } else {
        byteSkipped += 1;
      }
      source.advance();
      target.advance();
    }
  } catch {
    // Neither a Supabase nor a Cloudflare error body may reach the caller;
    // the report says which side failed and nothing more.
    return { ...base, status: "unavailable", unavailable: side };
  }

  const bytesComplete = byteSkipped === 0;
  const complete = presenceComplete && bytesComplete;
  const drifted = disappearingFaces.value.total
    + targetOnly.value.total
    + differentBucket.value.total
    + sourceUnreadable.value.total
    + targetUnreadable.value.total
    + bothUnreadable.value.total;

  return {
    generatedAt: base.generatedAt,
    // No drift found in a comparison that stopped early proves nothing about
    // the rest, so it is not allowed to say "equal".
    status: drifted > 0 ? "drifted" : complete ? "equal" : "partial",
    complete,
    presenceComplete,
    bytesComplete,
    rowLimit,
    sampleLimit,
    byteCheckLimit,
    comparedSourceRows: source.consumed,
    comparedTargetRows: target.consumed,
    comparedThroughKey,
    disappearingFaces: disappearingFaces.value,
    targetOnly: targetOnly.value,
    bytes: {
      checked: byteChecks,
      skipped: byteSkipped,
      equal: equalBucket.value,
      different: differentBucket.value,
      sourceUnreadable: sourceUnreadable.value,
      targetUnreadable: targetUnreadable.value,
      bothUnreadable: bothUnreadable.value,
    },
    unavailable: null,
  };
}

/** Parses the `avatarObjectParity` query flag: `1`/`true`/`all` turn it on, anything else leaves it off. */
export function parseAvatarObjectParityFlag(value: string | null): boolean {
  return value === "1" || value === "true" || value === "all";
}
