import { assertServerOnly } from "@/lib/auth/server-only";
import {
  listSupabaseGoogleIdentities,
  type SupabaseGoogleIdentity,
} from "@/lib/auth/supabase";
import { nativeAuthEnabled } from "@/lib/auth/env";
import { googleOAuthServerFlowConfigured } from "@/lib/auth/google-oauth-server";
import {
  nativeAuthDataAuthority,
  nativeAuthCutoverActive,
} from "./native-auth-readiness";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";

/*
  This is an audit, not a migrator. It reports aggregate counts only and never
  writes an identity mapping. A separate, explicitly approved backfill will
  use this exact subject -> existing app_users.id proof when it is introduced.
*/

const MODULE = "lib/cloudflare/native-identity-audit.ts";
const D1_CHUNK_SIZE = 80;

export interface NativeIdentityReadinessReport {
  generatedAt: string;
  configured: {
    nativeAuthFlag: boolean;
    cutoverActive: boolean;
    directGoogleServerFlow: boolean;
    dataAuthority: ReturnType<typeof nativeAuthDataAuthority>;
  };
  source: {
    status: "available" | "unavailable" | "invalid";
    googleIdentities: number;
    invalidIdentities: number;
    duplicateSubjects: number;
    usersWithMultipleGoogleIdentities: number;
  };
  target: {
    schema: "ready" | "missing" | "unavailable";
    sourceUsersPresent: number;
    sourceUsersMissing: number;
  };
  mappings: {
    correct: number;
    missing: number;
    mismatched: number;
  };
  readyForBackfill: boolean;
  readyForGoogleCutover: boolean;
  blockers: string[];
}

interface ValidSourceIdentity {
  userId: string;
  subject: string;
}

interface IdentityMappingRow {
  provider_subject: string;
  user_id: string;
}

function chunk<T>(values: readonly T[], size = D1_CHUNK_SIZE): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) result.push(values.slice(start, start + size));
  return result;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function normaliseSourceIdentity(value: SupabaseGoogleIdentity): ValidSourceIdentity | null {
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
  return { userId, subject };
}

async function targetSchema(
  bindings: BandUpCloudflareBindings,
): Promise<"ready" | "missing" | "unavailable"> {
  try {
    const tables = await bindings.db.prepare(`
      SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('app_users', 'app_user_identities', 'app_auth_sessions')
    `).all<{ name: string }>();
    const names = new Set(tables.results.map((row) => row.name));
    if (!names.has("app_users") || !names.has("app_user_identities") || !names.has("app_auth_sessions")) {
      return "missing";
    }
    // The column is the other load-bearing portion of migration 0015. Reading
    // it also keeps a half-applied or manually-created table from looking safe.
    await bindings.db.prepare("SELECT identity_authority FROM app_users LIMIT 1").all();
    return "ready";
  } catch {
    return "unavailable";
  }
}

async function targetIdentityState(
  source: readonly ValidSourceIdentity[],
  bindings: BandUpCloudflareBindings,
): Promise<{ liveUserIds: Set<string>; mappings: Map<string, string> }> {
  const userIds = [...new Set(source.map((identity) => identity.userId))];
  const subjects = [...new Set(source.map((identity) => identity.subject))];
  const liveUserIds = new Set<string>();
  const mappings = new Map<string, string>();

  for (const values of chunk(userIds)) {
    const rows = await bindings.db.prepare(`
      SELECT id FROM app_users
       WHERE deleted_at IS NULL AND id IN (${placeholders(values.length)})
    `).bind(...values).all<{ id: string }>();
    for (const row of rows.results) liveUserIds.add(row.id);
  }
  for (const values of chunk(subjects)) {
    const rows = await bindings.db.prepare(`
      SELECT provider_subject, user_id FROM app_user_identities
       WHERE provider = 'google' AND provider_subject IN (${placeholders(values.length)})
    `).bind(...values).all<IdentityMappingRow>();
    for (const row of rows.results) mappings.set(row.provider_subject, row.user_id);
  }
  return { liveUserIds, mappings };
}

/**
 * Private aggregate proof for the owner dashboard. No email, user id or Google
 * subject is returned, so checking readiness cannot become a directory API.
 */
export async function nativeIdentityReadinessReport(
  providedBindings?: BandUpCloudflareBindings,
  options: { readSource?: () => Promise<SupabaseGoogleIdentity[]> } = {},
): Promise<NativeIdentityReadinessReport> {
  assertServerOnly(MODULE);
  const configured = {
    nativeAuthFlag: nativeAuthEnabled(),
    cutoverActive: nativeAuthCutoverActive(),
    directGoogleServerFlow: googleOAuthServerFlowConfigured(),
    dataAuthority: nativeAuthDataAuthority(),
  };
  const blockers: string[] = [];
  let rawSource: SupabaseGoogleIdentity[];
  try {
    rawSource = await (options.readSource ?? listSupabaseGoogleIdentities)();
  } catch {
    return {
      generatedAt: new Date().toISOString(),
      configured,
      source: { status: "unavailable", googleIdentities: 0, invalidIdentities: 0, duplicateSubjects: 0, usersWithMultipleGoogleIdentities: 0 },
      target: { schema: "unavailable", sourceUsersPresent: 0, sourceUsersMissing: 0 },
      mappings: { correct: 0, missing: 0, mismatched: 0 },
      readyForBackfill: false,
      readyForGoogleCutover: false,
      blockers: ["Supabase Auth Google-identity evidence is unavailable"],
    };
  }

  const valid = rawSource.flatMap((identity) => {
    const normalised = normaliseSourceIdentity(identity);
    return normalised ? [normalised] : [];
  });
  const invalidIdentities = rawSource.length - valid.length;
  const subjects = new Set<string>();
  const users = new Map<string, number>();
  let duplicateSubjects = 0;
  for (const identity of valid) {
    if (subjects.has(identity.subject)) duplicateSubjects += 1;
    subjects.add(identity.subject);
    users.set(identity.userId, (users.get(identity.userId) ?? 0) + 1);
  }
  const usersWithMultipleGoogleIdentities = [...users.values()].filter((count) => count > 1).length;
  const sourceStatus: NativeIdentityReadinessReport["source"]["status"] = invalidIdentities > 0
    ? "invalid"
    : "available";
  if (invalidIdentities > 0) blockers.push(`${invalidIdentities} Google identity record(s) are malformed or linked to the wrong Supabase user id`);
  if (duplicateSubjects > 0) blockers.push(`${duplicateSubjects} duplicate Google provider subject(s) appear in Supabase Auth`);
  if (usersWithMultipleGoogleIdentities > 0) blockers.push(`${usersWithMultipleGoogleIdentities} user(s) have more than one Google identity`);

  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const schema = await targetSchema(bindings);
  if (schema !== "ready") {
    blockers.push(schema === "missing"
      ? "D1 identity migration 0015 has not been applied"
      : "D1 identity schema could not be checked");
    return {
      generatedAt: new Date().toISOString(),
      configured,
      source: { status: sourceStatus, googleIdentities: rawSource.length, invalidIdentities, duplicateSubjects, usersWithMultipleGoogleIdentities },
      target: { schema, sourceUsersPresent: 0, sourceUsersMissing: 0 },
      mappings: { correct: 0, missing: 0, mismatched: 0 },
      readyForBackfill: false,
      readyForGoogleCutover: false,
      blockers,
    };
  }

  let state: Awaited<ReturnType<typeof targetIdentityState>>;
  try {
    state = await targetIdentityState(valid, bindings);
  } catch {
    blockers.push("D1 identity records could not be checked");
    return {
      generatedAt: new Date().toISOString(),
      configured,
      source: { status: sourceStatus, googleIdentities: rawSource.length, invalidIdentities, duplicateSubjects, usersWithMultipleGoogleIdentities },
      target: { schema: "unavailable", sourceUsersPresent: 0, sourceUsersMissing: 0 },
      mappings: { correct: 0, missing: 0, mismatched: 0 },
      readyForBackfill: false,
      readyForGoogleCutover: false,
      blockers,
    };
  }

  let correct = 0;
  let missing = 0;
  let mismatched = 0;
  for (const identity of valid) {
    const mappedUserId = state.mappings.get(identity.subject);
    if (!mappedUserId) missing += 1;
    else if (mappedUserId === identity.userId) correct += 1;
    else mismatched += 1;
  }
  const sourceUsersMissing = [...users.keys()].filter((id) => !state.liveUserIds.has(id)).length;
  if (sourceUsersMissing > 0) blockers.push(`${sourceUsersMissing} Supabase Google account(s) are missing a live D1 app_users record`);
  if (mismatched > 0) blockers.push(`${mismatched} existing D1 mapping(s) point to a different user id`);
  if (missing > 0) blockers.push(`${missing} Google identity mapping(s) still need an approved backfill`);
  if (!configured.dataAuthority.ready) {
    blockers.push("learner and organization data must both be Cloudflare-authoritative before native sign-in can serve users");
  }
  if (!configured.directGoogleServerFlow) {
    blockers.push("the direct Google fallback needs GOOGLE_OAUTH_CLIENT_SECRET and an exact registered callback origin");
  }

  const sourceClean = sourceStatus === "available" && duplicateSubjects === 0 && usersWithMultipleGoogleIdentities === 0;
  const readyForBackfill = sourceClean && sourceUsersMissing === 0 && mismatched === 0;
  const readyForGoogleCutover = readyForBackfill
    && missing === 0
    && correct === valid.length
    && configured.dataAuthority.ready
    && configured.directGoogleServerFlow;
  return {
    generatedAt: new Date().toISOString(),
    configured,
    source: { status: sourceStatus, googleIdentities: rawSource.length, invalidIdentities, duplicateSubjects, usersWithMultipleGoogleIdentities },
    target: { schema, sourceUsersPresent: users.size - sourceUsersMissing, sourceUsersMissing },
    mappings: { correct, missing, mismatched },
    readyForBackfill,
    readyForGoogleCutover,
    blockers,
  };
}
