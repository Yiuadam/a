import { compare, hash } from "bcryptjs";
import { isAcceptedBcryptVerifier } from "./bcrypt-verifier";
import { assertServerOnly } from "./server-only";
import type { AuthedUser } from "./supabase";
import {
  createNativeBrowserSessionForUser,
  type NativeBrowserSession,
} from "@/lib/cloudflare/native-identity";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "@/lib/cloudflare/bindings";

/*
  Cloudflare-native verification for password users who were imported from
  Supabase Auth.

  `verifier` is bcrypt's one-way output, never a password.  It stays in this
  server-only module and is selected only to verify the password submitted to
  the sign-in route.  In particular, no profile/status/admin response can
  return it.

  Cloudflare Workers' built-in crypto supports Web Crypto PBKDF2 but not
  bcrypt.  The import has to preserve Supabase's bcrypt verifiers to avoid
  making people reset their passwords, so this module uses the small,
  dependency-free bcryptjs verifier only for that compatibility boundary.
*/

const MODULE = "lib/auth/native-password.ts";

/* A valid hash of a value that is never accepted as a BandUp password.
   Comparing it for an absent account makes the usual "wrong email" case do
   comparable work to the usual "wrong password" case. */
const BOGUS_BCRYPT_VERIFIER = "$2b$10$uQb1bJuQo/YbcXLikXVD4eub9yfpF5ZccnMnAe5Q3TcruOsU0EHyu";

/* Supabase's bcrypt output is 60 characters. Costs over 14 are deliberately
   rejected at import time: an attacker must not be able to turn a malformed
   migration artifact into an unbounded Worker CPU cost. */

interface PasswordUserRow {
  id: string;
  email: string | null;
  created_at: string;
  deleted_at: string | null;
  verifier: string;
  scheme: string;
  status: string | null;
}

function stamp(now = Date.now()): string {
  return new Date(now).toISOString();
}

/** True only for the constrained bcrypt verifier format accepted by D1. */
export function isImportedBcryptVerifier(value: unknown): value is string {
  return isAcceptedBcryptVerifier(value);
}

/**
 * Checks a password against a supplied Supabase-compatible bcrypt verifier.
 * Bad data is a failed check, never an exception whose message could reach a
 * caller or log the verifier.
 */
export async function verifyImportedBcryptPassword(
  password: string,
  verifier: string,
): Promise<boolean> {
  assertServerOnly(MODULE);
  if (!password || password.length > 200 || !isImportedBcryptVerifier(verifier)) return false;
  try {
    return await compare(password, verifier);
  } catch {
    return false;
  }
}

/**
 * Creates the same bounded bcrypt verifier format accepted for migrated
 * Supabase accounts. The fixed work factor prevents registration becoming a
 * Worker CPU denial-of-service primitive.
 */
export async function hashNativePassword(password: string): Promise<string | null> {
  assertServerOnly(MODULE);
  if (!password || password.length > 200) return null;
  try {
    const verifier = await hash(password, 10);
    return isImportedBcryptVerifier(verifier) ? verifier : null;
  } catch {
    return null;
  }
}

/**
 * Signs in a password account from Cloudflare D1 without consulting Supabase.
 * All failure cases intentionally become null so the route can retain its
 * existing non-enumerating response.
 */
export async function signInWithImportedNativePassword(
  email: string,
  password: string,
  signingSecret: string,
  providedBindings?: BandUpCloudflareBindings,
  now = Date.now(),
): Promise<NativeBrowserSession | null> {
  assertServerOnly(MODULE);
  if (!email || email.length > 254 || !password || password.length > 200 || !signingSecret) {
    return null;
  }

  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const row = await bindings.db.prepare(`
    SELECT u.id, u.email, u.created_at, u.deleted_at, c.verifier, c.scheme, c.status
      FROM app_users u
      LEFT JOIN app_password_credentials c ON c.user_id = u.id
     WHERE u.email IS NOT NULL
       AND lower(u.email) = lower(?)
       AND u.deleted_at IS NULL
     LIMIT 1
  `).bind(email).first<PasswordUserRow>();

  /* Do not let a missing credential skip the bcrypt work entirely. */
  const activeVerifier = Boolean(
    row
    && row.deleted_at === null
    && row.scheme === "bcrypt"
    && row.status === "active"
    && isImportedBcryptVerifier(row.verifier),
  );
  const verifier = activeVerifier ? row!.verifier : BOGUS_BCRYPT_VERIFIER;
  const matched = await verifyImportedBcryptPassword(password, verifier);
  if (!row || !activeVerifier || !matched) return null;

  const at = stamp(now);
  const touched = await bindings.db.batch([
    bindings.db.prepare(`
      UPDATE app_password_credentials
         SET last_verified_at = ?, updated_at = ?
       WHERE user_id = ? AND verifier = ? AND scheme = 'bcrypt'
    `).bind(at, at, row.id, row.verifier),
    bindings.db.prepare(`
      UPDATE app_users
         SET identity_authority = 'cloudflare', updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
    `).bind(at, row.id),
  ]);
  if (touched.some((result) => !result.success)) {
    throw new Error("native password credential could not be recorded");
  }

  const user: AuthedUser = { id: row.id, email: row.email, createdAt: row.created_at };
  return createNativeBrowserSessionForUser(user, signingSecret, bindings, now);
}
