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
import type { VerifiedAppleIdentity } from "@/lib/auth/apple-token";
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

export async function createNativeBrowserSessionForUser(
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

/**
 * Issues a Cloudflare-native session for someone who has just proved their
 * identity with a still-valid legacy Supabase access token.
 *
 * This is deliberately a bridge rather than an account importer.  It can only
 * name the exact user id that Supabase authenticated, and it refuses if that
 * id is not already a live D1 user.  In particular it does not create an
 * account from an email address: doing so would turn an incomplete data copy
 * into a silent, permanent split identity.  The browser keeps its working
 * legacy session when this returns null and tries again after the migration
 * has caught up.
 */
export async function bridgeLegacyBrowserSession(
  legacyUser: AuthedUser,
  signingSecret: string,
  providedBindings?: BandUpCloudflareBindings,
  now = Date.now(),
): Promise<NativeBrowserSession | null> {
  assertServerOnly(MODULE);
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const row = await bindings.db.prepare(`
    SELECT id, email, created_at, deleted_at
      FROM app_users
     WHERE id = ?
     LIMIT 1
  `).bind(legacyUser.id).first<UserRow>();
  if (!isLiveUser(row)) return null;

  /*
   * D1's row is the session source of truth from this point onwards.  Do not
   * overwrite its email from the compatibility provider here: an email change
   * needs the audited identity-sync path, not an opportunistic login write.
   */
  return createNativeBrowserSessionForUser({
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
  }, signingSecret, bindings, now);
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
  return user ? createNativeBrowserSessionForUser(user, signingSecret, bindings) : null;
}

async function existingAppleUser(
  subject: string,
  bindings: BandUpCloudflareBindings,
): Promise<UserRow | null> {
  return await bindings.db.prepare(`
    SELECT u.id, u.email, u.created_at, u.deleted_at
      FROM app_user_identities i
      JOIN app_users u ON u.id = i.user_id
     WHERE i.provider = 'apple' AND i.provider_subject = ?
     LIMIT 1
  `).bind(subject).first<UserRow>();
}

/**
 * Writes a name onto a profile that has none, and leaves every other profile
 * exactly as it was.
 *
 * This exists because of a rule that has no equivalent anywhere else in the
 * app: Apple sends the learner's name in the very first authorization and never
 * again — not on the next sign-in, not on request, and not after a reinstall
 * unless they first revoke the app in their Apple ID settings. So there is one
 * request in the life of an account in which this can be captured, and if it is
 * missed the name is not merely stale, it is unobtainable.
 *
 * The upsert's WHERE clause is the whole of the safety here. It is not an
 * optimisation: a learner who has since set their own display name must not
 * have it replaced by whatever Apple remembers, and a second sign-in that
 * somehow carried a name again must not overwrite a considered choice with an
 * Apple ID's idea of one. Only a profile with nothing in the field is touched.
 */
async function recordAppleDisplayName(
  userId: string,
  displayName: string,
  bindings: BandUpCloudflareBindings,
  now: string,
): Promise<void> {
  await bindings.db.prepare(`
    INSERT INTO learner_profiles (user_id, display_name, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE
       SET display_name = excluded.display_name,
           updated_at = excluded.updated_at
     WHERE learner_profiles.display_name IS NULL
  `).bind(userId, displayName, now).run();
}

/**
 * Resolves a verified Apple subject to a BandUp id.
 *
 * The same rule as its Google counterpart, and for the same reason: an existing
 * account is linked only by an audited backfill from a provider subject to an
 * already-stable app_users.id, never by a matching email address. Apple makes
 * that rule sharper rather than softer. The address in an Apple token may be a
 * Private Relay forwarder minted for this app alone, it may be switched off or
 * changed later, and it may not be there at all — so an email match here would
 * be a takeover boundary crossed on the strength of a value the learner can
 * change from their phone.
 *
 * Which is also why `email` is only ever written when Apple actually sent one.
 * Copying an absent address over a stored one would quietly empty the column
 * that the sign-in-link recovery path depends on, and the learner would find out
 * on the day they could not get in.
 *
 * @param displayName A name from Apple's first-authorization form post, or null
 *   on every subsequent sign-in — which is all of them but the first.
 */
export async function resolveAppleIdentity(
  identity: VerifiedAppleIdentity,
  displayName: string | null,
  providedBindings?: BandUpCloudflareBindings,
): Promise<AuthedUser | null> {
  assertServerOnly(MODULE);
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const now = stamp();
  let user = await existingAppleUser(identity.subject, bindings);
  let created = false;
  if (!user) {
    const id = crypto.randomUUID();
    try {
      // Atomic for the reason the Google path spells out: a concurrent first
      // sign-in that won the identity constraint after this request had already
      // written app_users would leave an unreachable account behind.
      const writes = await bindings.db.batch([
        bindings.db.prepare(`
          INSERT INTO app_users (id, email, role, created_at, updated_at, identity_authority)
          VALUES (?, ?, 'user', ?, ?, 'cloudflare')
        `).bind(id, identity.email, now, now),
        bindings.db.prepare(`
          INSERT INTO app_user_identities (
            provider, provider_subject, user_id, email, email_verified, created_at, last_seen_at
          ) VALUES ('apple', ?, ?, ?, ?, ?, ?)
        `).bind(identity.subject, id, identity.email, identity.emailVerified ? 1 : 0, now, now),
      ]);
      if (writes.some((write) => !write.success)) throw new Error("native user could not be created");
      user = { id, email: identity.email, created_at: now, deleted_at: null };
      created = true;
    } catch (error) {
      const resolved = await existingAppleUser(identity.subject, bindings);
      if (resolved) user = resolved;
      else {
        /*
          An address that already belongs to a live account is the one failure
          with a sanctioned outcome, and the outcome is to refuse. It happens
          when somebody who signed up with that address, or with Google on that
          address, later arrives through Apple: two doors to one address, and no
          proof that the person at the second one is the person behind the
          first. Linking them is the audited backfill's job. Refusing costs that
          learner a sign-in; linking wrongly costs somebody their account.
        */
        if (identity.email) {
          const existingEmail = await bindings.db.prepare(`
            SELECT id FROM app_users
             WHERE lower(email) = lower(?) AND deleted_at IS NULL
             LIMIT 1
          `).bind(identity.email).first<{ id: string }>();
          if (existingEmail) return null;
        }
        throw error;
      }
    }
  }

  if (!isLiveUser(user)) return null;

  if (identity.email) {
    /*
      Tolerated rather than trusted. An address Apple sends today can already
      belong to another live BandUp account — most obviously when somebody turns
      Private Relay off and starts arriving with the real address they signed up
      with elsewhere — and app_users carries a unique index on it. There is
      nothing sensible to do about that here: the two accounts are a merge
      question for the audited path, and this request is a sign-in that has
      already succeeded. So the stored address simply stays as it was and the
      session is issued regardless. Failing the whole sign-in over a column the
      account is not identified by would be the tail wagging the dog.
    */
    try {
      const update = await bindings.db.prepare(`
        UPDATE app_users
           SET email = ?, identity_authority = 'cloudflare', updated_at = ?
         WHERE id = ? AND deleted_at IS NULL
      `).bind(identity.email, now, user.id).run();
      if (update.success) user = { ...user, email: identity.email };
    } catch {
      // Keep the address already on the account.
    }
  } else {
    const update = await bindings.db.prepare(`
      UPDATE app_users
         SET identity_authority = 'cloudflare', updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
    `).bind(now, user.id).run();
    if (!update.success) throw new Error("native identity could not be updated");
  }

  await bindings.db.prepare(`
    UPDATE app_user_identities
       SET email = coalesce(?, email),
           email_verified = ?,
           last_seen_at = ?
     WHERE provider = 'apple' AND provider_subject = ? AND user_id = ?
  `).bind(
    identity.email,
    identity.emailVerified ? 1 : 0,
    now,
    identity.subject,
    user.id,
  ).run();

  /*
    Attempted only on the request that created the account. Apple sends a name
    exactly once and that once is the first authorization, so a name arriving
    against an account that already existed is either a repeat Apple will not
    actually make or something forged in the form body — and neither is a reason
    to touch a profile that has been in use.
  */
  if (created && displayName) {
    try {
      await recordAppleDisplayName(user.id, displayName, bindings, now);
    } catch {
      // A profile row this could not write is a missing display name and
      // nothing more. The account exists and the session below is valid.
    }
  }

  return { id: user.id, email: user.email, createdAt: user.created_at };
}

export async function createAppleNativeSession(
  identity: VerifiedAppleIdentity,
  displayName: string | null,
  signingSecret: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<NativeBrowserSession | null> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const user = await resolveAppleIdentity(identity, displayName, bindings);
  return user ? createNativeBrowserSessionForUser(user, signingSecret, bindings) : null;
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
