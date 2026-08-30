import { assertServerOnly } from "@/lib/auth/server-only";
import { isAcceptedBcryptVerifier } from "@/lib/auth/bcrypt-verifier";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";

/*
  The only D1 writer for an imported legacy password verifier.

  It takes one record at a time. A source export may be retried freely: each
  D1 `batch()` atomically writes the verifier only when the source's immutable
  BandUp user id and current email exactly match a live D1 account. A failed
  or mismatched record makes no change; no email-based account linking exists.
*/

const MODULE = "lib/cloudflare/native-password-import.ts";

export interface ImportedPasswordCredential {
  userId: string;
  email: string;
  verifier: string;
  sourceUpdatedAt: string;
}

export type NativePasswordImportResult = "stored" | "already_newer" | "mismatch";

export interface NativePasswordImportBatchResult {
  status: "stored" | "mismatch";
  stored: number;
}

const MAX_BATCH_IMPORT = 500;

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

/** Validates untrusted request/export data without ever echoing its verifier. */
export function parseImportedPasswordCredential(value: unknown): ImportedPasswordCredential | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const userId = typeof source.userId === "string" ? source.userId.trim() : "";
  const email = typeof source.email === "string" ? source.email.trim().toLowerCase() : "";
  const verifier = source.verifier;
  const sourceUpdatedAt = timestamp(source.sourceUpdatedAt);
  if (userId.length < 16 || userId.length > 80) return null;
  if (!email || email.length > 254 || !email.includes("@")) return null;
  if (!isAcceptedBcryptVerifier(verifier) || !sourceUpdatedAt) return null;
  return { userId, email, verifier, sourceUpdatedAt };
}

function stamp(now = Date.now()): string {
  return new Date(now).toISOString();
}

function importStatements(
  bindings: BandUpCloudflareBindings,
  credential: ImportedPasswordCredential,
  now: number,
) {
  const importedAt = stamp(now);
  return [
    bindings.db.prepare(`
      INSERT INTO app_password_credentials (
        user_id, scheme, verifier, source_updated_at, imported_at, updated_at, migration_source
      )
      SELECT id, 'bcrypt', ?, ?, ?, ?, 'supabase_import'
        FROM app_users
       WHERE id = ?
         AND deleted_at IS NULL
         AND email IS NOT NULL
         AND lower(email) = lower(?)
      ON CONFLICT(user_id) DO UPDATE SET
        verifier = excluded.verifier,
        source_updated_at = excluded.source_updated_at,
        imported_at = excluded.imported_at,
        updated_at = excluded.updated_at,
        migration_source = excluded.migration_source
      WHERE excluded.source_updated_at >= app_password_credentials.source_updated_at
    `).bind(
      credential.verifier,
      credential.sourceUpdatedAt,
      importedAt,
      importedAt,
      credential.userId,
      credential.email,
    ),
    bindings.db.prepare(`
      UPDATE app_users
         SET identity_authority = 'cloudflare', updated_at = ?
       WHERE id = ?
         AND deleted_at IS NULL
         AND email IS NOT NULL
         AND lower(email) = lower(?)
    `).bind(importedAt, credential.userId, credential.email),
  ];
}

/*
  A D1 batch is a transaction only when a statement actually fails. A guarded
  `INSERT … SELECT` which finds no row is still a successful statement, so a
  later `meta.changes === 0` check would be too late: earlier credentials in
  the batch could already have committed. This final read intentionally raises
  SQLite's deterministic integer-overflow error when the just-written record
  is not an exact source match. That makes D1 roll back the *entire* batch.

  `abs(-9223372036854775808)` is a core SQLite error expression (not an
  application-defined function) and is evaluated only on the failed CASE arm.
*/
function exactImportGuardStatement(
  bindings: BandUpCloudflareBindings,
  credential: ImportedPasswordCredential,
) {
  return bindings.db.prepare(`
    SELECT CASE WHEN EXISTS (
      SELECT 1
        FROM app_password_credentials credential
        JOIN app_users account ON account.id = credential.user_id
       WHERE credential.user_id = ?
         AND credential.scheme = 'bcrypt'
         AND credential.verifier = ?
         AND credential.source_updated_at = ?
         AND credential.migration_source = 'supabase_import'
         AND account.deleted_at IS NULL
         AND account.email IS NOT NULL
         AND lower(account.email) = lower(?)
    ) THEN 1 ELSE abs(-9223372036854775808) END AS exact_import
  `).bind(
    credential.userId,
    credential.verifier,
    credential.sourceUpdatedAt,
    credential.email,
  );
}

/**
 * Stores one verifier in an atomic D1 batch.
 *
 * Both statements predicate on the exact live D1 user id and email. If that
 * identity has changed since the export, both are no-ops and the caller gets
 * `mismatch`; no credential is ever attached to a different account.
 */
export async function importNativePasswordCredential(
  credential: ImportedPasswordCredential,
  providedBindings?: BandUpCloudflareBindings,
  now = Date.now(),
): Promise<NativePasswordImportResult> {
  assertServerOnly(MODULE);
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const results = await bindings.db.batch(importStatements(bindings, credential, now));
  if (results.some((result) => !result.success)) {
    throw new Error("native password credential could not be imported");
  }
  if ((results[1]?.meta.changes ?? 0) !== 1) return "mismatch";
  return (results[0]?.meta.changes ?? 0) === 1 ? "stored" : "already_newer";
}

/**
 * Imports a complete, already-validated source snapshot. The preflight is
 * deliberately a read before the atomic D1 batch: every record must point at
 * the same live D1 account and email before any password verifier can change.
 * A failed batch rolls back as a unit; a concurrent account change produces a
 * mismatch receipt and cannot be certified as a completed migration. The
 * final guard statement for every credential turns a zero-row concurrent
 * write into a SQLite error, which makes D1 roll the complete batch back.
 */
export async function importNativePasswordCredentialBatch(
  credentials: readonly ImportedPasswordCredential[],
  providedBindings?: BandUpCloudflareBindings,
  now = Date.now(),
): Promise<NativePasswordImportBatchResult> {
  assertServerOnly(MODULE);
  if (credentials.length === 0 || credentials.length > MAX_BATCH_IMPORT) {
    return { status: "mismatch", stored: 0 };
  }
  const ids = new Set<string>();
  const emails = new Set<string>();
  for (const credential of credentials) {
    if (!parseImportedPasswordCredential(credential)
      || ids.has(credential.userId)
      || emails.has(credential.email.toLowerCase())) {
      return { status: "mismatch", stored: 0 };
    }
    ids.add(credential.userId);
    emails.add(credential.email.toLowerCase());
  }

  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const placeholders = credentials.map(() => "?").join(", ");
  const accounts = await bindings.db.prepare(`
    SELECT id, email FROM app_users
     WHERE deleted_at IS NULL
       AND id IN (${placeholders})
  `).bind(...credentials.map((credential) => credential.userId)).all<{ id: string; email: string | null }>();
  if (!accounts.success || accounts.results.length !== credentials.length) {
    return { status: "mismatch", stored: 0 };
  }
  const emailsById = new Map(accounts.results.map((account) => [account.id, account.email?.toLowerCase() ?? ""]));
  if (credentials.some((credential) => emailsById.get(credential.userId) !== credential.email.toLowerCase())) {
    return { status: "mismatch", stored: 0 };
  }

  const results = await bindings.db.batch(credentials.flatMap((credential) => [
    ...importStatements(bindings, credential, now),
    exactImportGuardStatement(bindings, credential),
  ]));
  if (results.length !== credentials.length * 3 || results.some((result) => !result.success)) {
    throw new Error("native password credential batch could not be imported");
  }
  const writesChangedExactlyOnce = credentials.every((_, index) => {
    const writeResults = results.slice(index * 3, index * 3 + 2);
    return writeResults.every((result) => (result.meta.changes ?? 0) === 1);
  });
  if (!writesChangedExactlyOnce) {
    return { status: "mismatch", stored: 0 };
  }
  return { status: "stored", stored: credentials.length };
}
