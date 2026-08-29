import { assertServerOnly } from "@/lib/auth/server-only";
import {
  listSupabaseGoogleIdentities,
  listSupabaseNativeIdentitySource,
  type SupabaseGoogleIdentity,
} from "@/lib/auth/supabase";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";

/*
  The only writer for legacy Google identity links.

  It never discovers a user by email. Every link is the immutable Google
  provider subject from Supabase Auth paired with that source record's exact
  existing app_users.id. The complete source is validated before any batch is
  written, so a partial or contradictory Auth listing cannot become a partial
  Cloudflare identity migration.
*/

const MODULE = "lib/cloudflare/native-identity-backfill.ts";
const D1_CHUNK_SIZE = 80;

interface SafeSourceIdentity {
  userId: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
}

interface MappingRow {
  provider_subject: string;
  user_id: string;
}

export interface NativeIdentityBackfillResult {
  sourceGoogleIdentities: number;
  mappingsCreated: number;
  mappingsAlreadyCorrect: number;
}

function stamp(now = Date.now()): string {
  return new Date(now).toISOString();
}

function chunk<T>(values: readonly T[], size = D1_CHUNK_SIZE): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) result.push(values.slice(start, start + size));
  return result;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function normalise(value: SupabaseGoogleIdentity): SafeSourceIdentity | null {
  const userId = value.authUserId;
  const subject = value.providerSubject;
  if (!(typeof userId === "string"
    && typeof value.identityUserId === "string"
    && userId === value.identityUserId
    && userId.length >= 16
    && userId.length <= 80
    && typeof subject === "string"
    && subject.length >= 1
    && subject.length <= 255)) return null;
  const email = typeof value.email === "string" && value.email.length >= 3 && value.email.length <= 254
    ? value.email.trim().toLowerCase()
    : null;
  return { userId, subject, email, emailVerified: value.emailVerified === true };
}

function validateSource(source: readonly SupabaseGoogleIdentity[]): SafeSourceIdentity[] {
  const valid = source.flatMap((identity) => {
    const row = normalise(identity);
    return row ? [row] : [];
  });
  if (valid.length !== source.length) throw new Error("Google identity source is malformed");

  const subjects = new Set<string>();
  const users = new Set<string>();
  for (const row of valid) {
    if (subjects.has(row.subject)) throw new Error("Google identity source has duplicate provider subjects");
    if (users.has(row.userId)) throw new Error("Google identity source has multiple Google identities for one user");
    subjects.add(row.subject);
    users.add(row.userId);
  }
  return valid;
}

async function sourceGoogleIdentities(
  provided?: () => Promise<SupabaseGoogleIdentity[]>,
): Promise<SupabaseGoogleIdentity[]> {
  if (provided) return provided();
  try {
    return await listSupabaseGoogleIdentities();
  } catch {
    /* Auth Admin can return identities:null. Use the same short-lived,
       service-role-only source proof that the readiness audit already trusts. */
    return (await listSupabaseNativeIdentitySource()).googleIdentities;
  }
}

/**
 * Idempotently copies reviewed source-subject mappings to D1.
 *
 * Any missing target user or conflicting D1 identity stops before a write. A
 * retry is safe: rows already mapped to the same stable user id are counted,
 * not relinked or recreated.
 */
export async function backfillNativeGoogleIdentities(
  providedBindings?: BandUpCloudflareBindings,
  options: { readSource?: () => Promise<SupabaseGoogleIdentity[]>; now?: number } = {},
): Promise<NativeIdentityBackfillResult> {
  assertServerOnly(MODULE);
  const source = validateSource(await sourceGoogleIdentities(options.readSource));
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const userIds = source.map((row) => row.userId);
  const subjects = source.map((row) => row.subject);
  const liveUsers = new Set<string>();
  const subjectMappings = new Map<string, string>();
  const userMappings = new Map<string, string>();

  for (const values of chunk(userIds)) {
    const rows = await bindings.db.prepare(`
      SELECT id FROM app_users
       WHERE deleted_at IS NULL AND id IN (${placeholders(values.length)})
    `).bind(...values).all<{ id: string }>();
    for (const row of rows.results) liveUsers.add(row.id);
  }
  if (liveUsers.size !== new Set(userIds).size) {
    throw new Error("one or more Google identities do not have a live D1 user");
  }

  for (const values of chunk(subjects)) {
    const rows = await bindings.db.prepare(`
      SELECT provider_subject, user_id FROM app_user_identities
       WHERE provider = 'google' AND provider_subject IN (${placeholders(values.length)})
    `).bind(...values).all<MappingRow>();
    for (const row of rows.results) subjectMappings.set(row.provider_subject, row.user_id);
  }
  for (const values of chunk(userIds)) {
    const rows = await bindings.db.prepare(`
      SELECT provider_subject, user_id FROM app_user_identities
       WHERE provider = 'google' AND user_id IN (${placeholders(values.length)})
    `).bind(...values).all<MappingRow>();
    for (const row of rows.results) userMappings.set(row.user_id, row.provider_subject);
  }

  const missing: SafeSourceIdentity[] = [];
  let alreadyCorrect = 0;
  for (const identity of source) {
    const subjectOwner = subjectMappings.get(identity.subject);
    const userSubject = userMappings.get(identity.userId);
    if (subjectOwner && subjectOwner !== identity.userId) {
      throw new Error("an existing Google subject mapping points to another user");
    }
    if (userSubject && userSubject !== identity.subject) {
      throw new Error("an existing user has a different Google subject mapping");
    }
    if (subjectOwner === identity.userId && userSubject === identity.subject) alreadyCorrect += 1;
    else missing.push(identity);
  }

  const now = stamp(options.now);
  for (const group of chunk(missing)) {
    const writes = await bindings.db.batch(group.map((identity) => bindings.db.prepare(`
      INSERT INTO app_user_identities (
        provider, provider_subject, user_id, email, email_verified, created_at, last_seen_at
      ) VALUES ('google', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, provider_subject) DO UPDATE SET
        email = coalesce(excluded.email, app_user_identities.email),
        email_verified = max(app_user_identities.email_verified, excluded.email_verified),
        last_seen_at = excluded.last_seen_at
      WHERE app_user_identities.user_id = excluded.user_id
    `).bind(
      identity.subject,
      identity.userId,
      identity.email,
      identity.emailVerified ? 1 : 0,
      now,
      now,
    )));
    if (writes.some((result) => !result.success)) {
      throw new Error("a Google identity mapping could not be written");
    }
  }

  return {
    sourceGoogleIdentities: source.length,
    mappingsCreated: missing.length,
    mappingsAlreadyCorrect: alreadyCorrect,
  };
}
