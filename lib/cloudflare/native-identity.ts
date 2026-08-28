import { assertServerOnly } from "@/lib/auth/server-only";
import type { AuthedUser } from "@/lib/auth/supabase";
import {
  ACCESS_TOKEN_SECONDS,
  createNativeAccessToken,
  randomSessionToken,
  sha256Hex,
  verifyNativeAccessToken,
} from "@/lib/auth/native-session";
import type { VerifiedGoogleIdentity } from "@/lib/auth/google-token";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";

const MODULE = "lib/cloudflare/native-identity.ts";
const REFRESH_SESSION_DAYS = 30;

interface UserRow {
  id: string;
  email: string | null;
  created_at: string;
  deleted_at: string | null;
}

interface StoredSession extends UserRow {
  session_id: string;
}

export interface NativeBrowserSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email: string | null;
}

function stamp(now = Date.now()): string {
  return new Date(now).toISOString();
}

function isLiveUser(row: UserRow | null): row is UserRow {
  return Boolean(row && row.id && row.deleted_at === null);
}

async function nativeSessionFor(
  user: AuthedUser,
  signingSecret: string,
  bindings: BandUpCloudflareBindings,
  now = Date.now(),
): Promise<NativeBrowserSession> {
  const sessionId = crypto.randomUUID();
  const refreshToken = randomSessionToken();
  const refreshHash = await sha256Hex(refreshToken);
  const createdAt = stamp(now);
  const expiresAt = stamp(now + REFRESH_SESSION_DAYS * 24 * 60 * 60 * 1000);
  const stored = await bindings.db.prepare(`
    INSERT INTO app_auth_sessions (
      id, user_id, refresh_token_sha256, created_at, last_seen_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(sessionId, user.id, refreshHash, createdAt, createdAt, expiresAt).run();
  if (!stored.success) throw new Error("native session could not be stored");
  const access = await createNativeAccessToken(user, sessionId, signingSecret, now);
  return { ...access, refreshToken, email: user.email };
}

async function existingGoogleUser(
  subject: string,
  bindings: BandUpCloudflareBindings,
): Promise<UserRow | null> {
  return await bindings.db.prepare(`
    SELECT u.id, u.email, u.created_at, u.deleted_at
      FROM app_user_identities i
      JOIN app_users u ON u.id = i.user_id
     WHERE i.provider = 'google' AND i.provider_subject = ?
     LIMIT 1
  `).bind(subject).first<UserRow>();
}

/**
 * Resolves a verified Google subject to a BandUp id.
 *
 * Existing accounts are linked only by the audited backfill from Supabase's
 * provider subject to their already-stable `app_users.id`. A verified email is
 * deliberately insufficient: it is mutable profile data, and automatically
 * attaching a new external identity to a legacy account is an account-takeover
 * boundary. If the email already belongs to a live BandUp account but has no
 * subject mapping, the migration must be completed before that person can use
 * native sign-in.
 */
export async function resolveGoogleIdentity(
  identity: VerifiedGoogleIdentity,
  providedBindings?: BandUpCloudflareBindings,
): Promise<AuthedUser | null> {
  assertServerOnly(MODULE);
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const now = stamp();
  let user = await existingGoogleUser(identity.subject, bindings);
  if (!user) {
    const id = crypto.randomUUID();
    try {
      /*
        These writes must succeed or fail together. With two separate calls a
        concurrent first sign-in could win the Google-subject constraint after
        this request had already made an app_users row, leaving an unreachable
        duplicate email behind. D1 batch is atomic, so the losing request has
        no partial account to clean up.
      */
      const writes = await bindings.db.batch([
        bindings.db.prepare(`
          INSERT INTO app_users (id, email, role, created_at, updated_at, identity_authority)
          VALUES (?, ?, 'user', ?, ?, 'cloudflare')
        `).bind(id, identity.email, now, now),
        bindings.db.prepare(`
          INSERT INTO app_user_identities (
            provider, provider_subject, user_id, email, email_verified, created_at, last_seen_at
          ) VALUES ('google', ?, ?, ?, 1, ?, ?)
        `).bind(identity.subject, id, identity.email, now, now),
      ]);
      if (writes.some((write) => !write.success)) throw new Error("native user could not be created");
      user = { id, email: identity.email, created_at: now, deleted_at: null };
    } catch (error) {
      // Either another request completed this exact Google identity first, or
      // an existing legacy account owns the email. The former is safe to use;
      // the latter must wait for the subject-audited backfill, never be linked
      // by email. Anything else remains an operational error.
      const resolved = await existingGoogleUser(identity.subject, bindings);
      if (resolved) user = resolved;
      else {
        const existingEmail = await bindings.db.prepare(`
          SELECT id FROM app_users
           WHERE lower(email) = lower(?) AND deleted_at IS NULL
           LIMIT 1
        `).bind(identity.email).first<{ id: string }>();
        if (existingEmail) return null;
        throw error;
      }
    }
  }

  if (!isLiveUser(user)) return null;
  const update = await bindings.db.prepare(`
    UPDATE app_users
       SET email = ?, identity_authority = 'cloudflare', updated_at = ?
     WHERE id = ? AND deleted_at IS NULL
  `).bind(identity.email, now, user.id).run();
  if (!update.success) throw new Error("native identity could not be updated");
  await bindings.db.prepare(`
    UPDATE app_user_identities
       SET email = ?, email_verified = 1, last_seen_at = ?
     WHERE provider = 'google' AND provider_subject = ? AND user_id = ?
  `).bind(identity.email, now, identity.subject, user.id).run();
  return { id: user.id, email: identity.email, createdAt: user.created_at };
}

export async function createGoogleNativeSession(
  identity: VerifiedGoogleIdentity,
  signingSecret: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<NativeBrowserSession | null> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const user = await resolveGoogleIdentity(identity, bindings);
  return user ? nativeSessionFor(user, signingSecret, bindings) : null;
}

/**
 * Authenticates a native bearer token against both its signature and its
 * server-side session row. This closes the revocation window that a signed JWT
 * alone would leave after sign-out or account deletion.
 */
export async function userFromNativeBrowserSessionToken(
  accessToken: string,
  signingSecret: string,
  providedBindings?: BandUpCloudflareBindings,
  now = Date.now(),
): Promise<AuthedUser | null> {
  assertServerOnly(MODULE);
  const verified = await verifyNativeAccessToken(accessToken, signingSecret, now);
  if (!verified) return null;

  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const row = await bindings.db.prepare(`
    SELECT u.id, u.email, u.created_at, u.deleted_at
      FROM app_auth_sessions s
      JOIN app_users u ON u.id = s.user_id
     WHERE s.id = ?
       AND s.user_id = ?
       AND s.revoked_at IS NULL
       AND s.expires_at > ?
       AND u.deleted_at IS NULL
     LIMIT 1
  `).bind(
    verified.sessionId,
    verified.user.id,
    stamp(now),
  ).first<UserRow>();
  if (!row || !isLiveUser(row)) return null;
  return { id: row.id, email: row.email, createdAt: row.created_at };
}

/**
 * Revokes the exact native session named by a signed access token. A repeated
 * sign-out is harmless, and an invalid/expired token deliberately reveals no
 * session state to the caller.
 */
export async function revokeNativeBrowserSessionToken(
  accessToken: string,
  signingSecret: string,
  providedBindings?: BandUpCloudflareBindings,
  now = Date.now(),
): Promise<void> {
  assertServerOnly(MODULE);
  const verified = await verifyNativeAccessToken(accessToken, signingSecret, now);
  if (!verified) return;
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  await bindings.db.prepare(`
    UPDATE app_auth_sessions
       SET revoked_at = coalesce(revoked_at, ?), last_seen_at = ?
     WHERE id = ? AND user_id = ?
  `).bind(
    stamp(now),
    stamp(now),
    verified.sessionId,
    verified.user.id,
  ).run();
}

/** Rotates a one-time refresh credential before returning a fresh access token. */
export async function refreshNativeBrowserSession(
  refreshToken: string,
  signingSecret: string,
  providedBindings?: BandUpCloudflareBindings,
  now = Date.now(),
): Promise<NativeBrowserSession | null> {
  assertServerOnly(MODULE);
  if (!refreshToken || refreshToken.length > 512) return null;
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const oldHash = await sha256Hex(refreshToken);
  const row = await bindings.db.prepare(`
    SELECT s.id AS session_id, u.id, u.email, u.created_at, u.deleted_at
      FROM app_auth_sessions s
      JOIN app_users u ON u.id = s.user_id
     WHERE s.refresh_token_sha256 = ?
       AND s.revoked_at IS NULL
       AND s.expires_at > ?
     LIMIT 1
  `).bind(oldHash, stamp(now)).first<StoredSession>();
  if (!row || row.deleted_at !== null) return null;

  const nextRefresh = randomSessionToken();
  const nextHash = await sha256Hex(nextRefresh);
  const updated = await bindings.db.prepare(`
    UPDATE app_auth_sessions
       SET refresh_token_sha256 = ?, last_seen_at = ?
     WHERE id = ? AND refresh_token_sha256 = ? AND revoked_at IS NULL
  `).bind(nextHash, stamp(now), row.session_id, oldHash).run();
  if (!updated.success || updated.meta.changes !== 1) return null;
  const user: AuthedUser = { id: row.id, email: row.email, createdAt: row.created_at };
  const access = await createNativeAccessToken(user, row.session_id, signingSecret, now);
  return { ...access, refreshToken: nextRefresh, email: row.email };
}

export const NATIVE_REFRESH_SESSION_DAYS = REFRESH_SESSION_DAYS;
export const NATIVE_ACCESS_TOKEN_SECONDS = ACCESS_TOKEN_SECONDS;
