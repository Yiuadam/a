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
  const importedAt = stamp(now);
  const results = await bindings.db.batch([
    bindings.db.prepare(`
      INSERT INTO app_password_credentials (
        user_id, scheme, verifier, source_updated_at, imported_at, updated_at
      )
      SELECT id, 'bcrypt', ?, ?, ?, ?
        FROM app_users
       WHERE id = ?
         AND deleted_at IS NULL
         AND email IS NOT NULL
         AND lower(email) = lower(?)
      ON CONFLICT(user_id) DO UPDATE SET
        verifier = excluded.verifier,
        source_updated_at = excluded.source_updated_at,
        imported_at = excluded.imported_at,
        updated_at = excluded.updated_at
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
  ]);
  if (results.some((result) => !result.success)) {
    throw new Error("native password credential could not be imported");
  }
  if ((results[1]?.meta.changes ?? 0) !== 1) return "mismatch";
  return (results[0]?.meta.changes ?? 0) === 1 ? "stored" : "already_newer";
}
