import { assertServerOnly } from "./server-only";
import { googleOAuthAppOrigin } from "./env";
import { hashNativePassword } from "./native-password";
import { randomSessionToken, sha256Hex } from "./native-session";
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
  Email confirmation and recovery for Cloudflare-native accounts.

  The raw action token is placed in the fragment of the email link. A fragment
  is never sent with the initial browser request, so it cannot land in Worker
  request logs or a Referer header. The callback page exchanges it once over
  HTTPS for a normal BandUp bearer session, then removes it from the address
  bar.
*/

const MODULE = "lib/auth/native-email.ts";
const ACTION_LIFETIME_MS = 60 * 60 * 1_000;
const FROM = { email: "accounts@bandup.life", name: "BandUp" };

type NativeEmailAction = "confirm_registration" | "recover_access";
type CallbackAction = "confirm" | "recover";

interface ActionRow {
  id: string;
  user_id: string;
  action: NativeEmailAction;
}

interface UserRow {
  id: string;
  email: string | null;
  created_at: string;
  deleted_at: string | null;
}

interface ExistingRegistrationRow extends UserRow {
  status: string | null;
}

function stamp(now = Date.now()): string {
  return new Date(now).toISOString();
}

function callbackAction(action: NativeEmailAction): CallbackAction {
  return action === "confirm_registration" ? "confirm" : "recover";
}

function emailAction(action: CallbackAction): NativeEmailAction | null {
  if (action === "confirm") return "confirm_registration";
  if (action === "recover") return "recover_access";
  return null;
}

function actionTitle(action: NativeEmailAction): string {
  return action === "confirm_registration" ? "Confirm your BandUp account" : "Sign in to BandUp";
}

function actionCopy(action: NativeEmailAction): string {
  return action === "confirm_registration"
    ? "Confirm your email address to finish creating your BandUp account."
    : "Use this one-time link to sign in to your BandUp account.";
}

function isLiveUser(row: UserRow | null): row is UserRow {
  return Boolean(row && row.id && row.deleted_at === null && row.email);
}

/** Strictly parse the opaque `uuid.random-secret` action token. */
export function parseNativeEmailActionToken(value: unknown): { id: string; token: string } | null {
  if (typeof value !== "string" || value.length < 54 || value.length > 256) return null;
  const first = value.indexOf(".");
  if (first < 1 || first !== value.lastIndexOf(".")) return null;
  const id = value.slice(0, first);
  const secret = value.slice(first + 1);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return null;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(secret)) return null;
  return { id, token: value };
}

/**
 * The one-time token is intentionally in the fragment rather than query
 * parameters. See the module comment above.
 */
export function nativeEmailCallbackUrl(
  appOrigin: string,
  action: CallbackAction,
  token: string,
): string {
  const target = new URL("/account/callback/", appOrigin);
  target.hash = new URLSearchParams({ email_action: action, email_token: token }).toString();
  return target.toString();
}

function appOrigin(): string | null {
  assertServerOnly(MODULE);
  return googleOAuthAppOrigin() ?? null;
}

async function sendActionEmail(
  email: string,
  action: NativeEmailAction,
  token: string,
  bindings: BandUpCloudflareBindings,
): Promise<void> {
  const origin = appOrigin();
  const sender = bindings.email;
  if (!origin || !sender) throw new Error("Cloudflare email is unavailable");

  const href = nativeEmailCallbackUrl(origin, callbackAction(action), token);
  const title = actionTitle(action);
  const copy = actionCopy(action);
  await sender.send({
    to: email,
    from: FROM,
    subject: title,
    text: `${copy}\n\n${href}\n\nThis link expires in one hour and can be used once. If you did not ask for it, you can ignore this email.`,
    html: `<p>${copy}</p><p><a href="${href}">${title}</a></p><p>This link expires in one hour and can be used once. If you did not ask for it, you can ignore this email.</p>`,
  });
}

async function issueAction(
  userId: string,
  action: NativeEmailAction,
  bindings: BandUpCloudflareBindings,
  now = Date.now(),
): Promise<string> {
  const id = crypto.randomUUID();
  const token = `${id}.${randomSessionToken(32)}`;
  const at = stamp(now);
  const writes = await bindings.db.batch([
    bindings.db.prepare(`
      UPDATE app_email_action_tokens
         SET consumed_at = ?
       WHERE user_id = ? AND action = ? AND consumed_at IS NULL
    `).bind(at, userId, action),
    bindings.db.prepare(`
      INSERT INTO app_email_action_tokens (
        id, user_id, action, token_sha256, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      userId,
      action,
      await sha256Hex(token),
      at,
      stamp(now + ACTION_LIFETIME_MS),
    ),
  ]);
  if (writes.some((write) => !write.success) || writes[1]?.meta.changes !== 1) {
    throw new Error("native email action could not be stored");
  }
  return token;
}

async function resendPendingRegistration(
  row: ExistingRegistrationRow,
  bindings: BandUpCloudflareBindings,
  now: number,
): Promise<boolean> {
  if (!isLiveUser(row) || row.status !== "pending" || !row.email) return true;
  const token = await issueAction(row.id, "confirm_registration", bindings, now);
  await sendActionEmail(row.email, "confirm_registration", token, bindings);
  return true;
}

/**
 * Starts a native email/password registration. The public result intentionally
 * does not say whether an address already exists, so this cannot be used as an
 * account-discovery endpoint.
 */
export async function startNativePasswordRegistration(
  email: string,
  password: string,
  providedBindings?: BandUpCloudflareBindings,
  now = Date.now(),
): Promise<boolean> {
  assertServerOnly(MODULE);
  if (!email || email.length > 254 || !password || password.length < 8 || password.length > 200) return false;
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const existing = await bindings.db.prepare(`
    SELECT u.id, u.email, u.created_at, u.deleted_at, c.status
      FROM app_users u
      LEFT JOIN app_password_credentials c ON c.user_id = u.id
     WHERE lower(u.email) = lower(?) AND u.deleted_at IS NULL
     LIMIT 1
  `).bind(email).first<ExistingRegistrationRow>();
  if (existing) return resendPendingRegistration(existing, bindings, now);

  const verifier = await hashNativePassword(password);
  if (!verifier) return false;
  const id = crypto.randomUUID();
  const at = stamp(now);
  try {
    const writes = await bindings.db.batch([
      bindings.db.prepare(`
        INSERT INTO app_users (id, email, role, created_at, updated_at, identity_authority)
        VALUES (?, ?, 'user', ?, ?, 'cloudflare')
      `).bind(id, email, at, at),
      bindings.db.prepare(`
        INSERT INTO app_password_credentials (
          user_id, scheme, verifier, source_updated_at, imported_at, updated_at, status, migration_source
        ) VALUES (?, 'bcrypt', ?, ?, ?, ?, 'pending', 'native_registration')
      `).bind(id, verifier, at, at, at, at),
    ]);
    if (writes.some((write) => !write.success)) return false;
  } catch {
    /* A concurrent registration may have created a pending row. Re-reading it
       lets a legitimate retry receive a fresh confirmation link, while still
       returning the same public response for an already-active address. */
    const raced = await bindings.db.prepare(`
      SELECT u.id, u.email, u.created_at, u.deleted_at, c.status
        FROM app_users u
        LEFT JOIN app_password_credentials c ON c.user_id = u.id
       WHERE lower(u.email) = lower(?) AND u.deleted_at IS NULL
       LIMIT 1
    `).bind(email).first<ExistingRegistrationRow>();
    if (!raced) return false;
    return resendPendingRegistration(raced, bindings, now);
  }

  const token = await issueAction(id, "confirm_registration", bindings, now);
  await sendActionEmail(email, "confirm_registration", token, bindings);
  return true;
}

/**
 * Sends a recovery sign-in link if the email belongs to a live native account.
 * Unknown addresses deliberately return success without sending anything.
 */
export async function startNativeAccountRecovery(
  email: string,
  providedBindings?: BandUpCloudflareBindings,
  now = Date.now(),
): Promise<boolean> {
  assertServerOnly(MODULE);
  if (!email || email.length > 254) return true;
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const user = await bindings.db.prepare(`
    SELECT u.id, u.email, u.created_at, u.deleted_at, c.status
      FROM app_users u
      LEFT JOIN app_password_credentials c ON c.user_id = u.id
     WHERE lower(u.email) = lower(?) AND u.deleted_at IS NULL
     LIMIT 1
  `).bind(email).first<ExistingRegistrationRow>();
  if (!isLiveUser(user) || !user.email) return true;
  /* A pending email/password account must confirm its address before it can
     receive a sign-in session. A recovery request is treated as a resend of
     that confirmation, not as a way around the pending state. */
  if (user.status === "pending") {
    const token = await issueAction(user.id, "confirm_registration", bindings, now);
    await sendActionEmail(user.email, "confirm_registration", token, bindings);
    return true;
  }
  const token = await issueAction(user.id, "recover_access", bindings, now);
  await sendActionEmail(user.email, "recover_access", token, bindings);
  return true;
}

/** Consumes one email action and returns a freshly issued Cloudflare session. */
export async function consumeNativeEmailAction(
  rawToken: unknown,
  expectedAction: unknown,
  signingSecret: string,
  providedBindings?: BandUpCloudflareBindings,
  now = Date.now(),
): Promise<NativeBrowserSession | null> {
  assertServerOnly(MODULE);
  const parsed = parseNativeEmailActionToken(rawToken);
  const action = typeof expectedAction === "string" ? emailAction(expectedAction as CallbackAction) : null;
  if (!parsed || !action || !signingSecret) return null;
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const at = stamp(now);
  const digest = await sha256Hex(parsed.token);
  const row = await bindings.db.prepare(`
    SELECT id, user_id, action
      FROM app_email_action_tokens
     WHERE id = ? AND token_sha256 = ? AND action = ?
       AND consumed_at IS NULL AND expires_at > ?
     LIMIT 1
  `).bind(parsed.id, digest, action, at).first<ActionRow>();
  if (!row || row.action !== action) return null;

  const writes = action === "confirm_registration"
    ? await bindings.db.batch([
      bindings.db.prepare(`
        UPDATE app_email_action_tokens
           SET consumed_at = ?
         WHERE id = ? AND token_sha256 = ? AND action = ?
           AND consumed_at IS NULL AND expires_at > ?
      `).bind(at, parsed.id, digest, action, at),
      bindings.db.prepare(`
        UPDATE app_password_credentials
           SET status = 'active', updated_at = ?
         WHERE user_id = ? AND status = 'pending'
      `).bind(at, row.user_id),
    ])
    : await bindings.db.batch([
      bindings.db.prepare(`
        UPDATE app_email_action_tokens
           SET consumed_at = ?
         WHERE id = ? AND token_sha256 = ? AND action = ?
           AND consumed_at IS NULL AND expires_at > ?
      `).bind(at, parsed.id, digest, action, at),
      bindings.db.prepare(`
        UPDATE app_users
           SET updated_at = ?
         WHERE id = ? AND deleted_at IS NULL
      `).bind(at, row.user_id),
    ]);
  if (writes.some((write) => !write.success) || writes[0]?.meta.changes !== 1 || writes[1]?.meta.changes !== 1) {
    return null;
  }

  const user = await bindings.db.prepare(`
    SELECT id, email, created_at, deleted_at
      FROM app_users
     WHERE id = ? AND deleted_at IS NULL
     LIMIT 1
  `).bind(row.user_id).first<UserRow>();
  if (!isLiveUser(user)) return null;
  const nativeUser: AuthedUser = { id: user.id, email: user.email, createdAt: user.created_at };
  return createNativeBrowserSessionForUser(nativeUser, signingSecret, bindings, now);
}

export const NATIVE_EMAIL_ACTION_LIFETIME_MS = ACTION_LIFETIME_MS;
