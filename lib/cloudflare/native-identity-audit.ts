import { assertServerOnly } from "@/lib/auth/server-only";
import {
  listSupabaseAuthAccounts,
  listSupabaseGoogleIdentities,
  listSupabaseAuthProviderSummary,
  listSupabaseNativeIdentitySource,
  type SupabaseAuthAccount,
  type SupabaseGoogleIdentity,
  type SupabaseAuthProviderSummary,
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
import {
  nativePasswordMigrationEvidence,
  type NativePasswordMigrationEvidence,
} from "./native-password-migration-audit";

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
    appleIdentities: number;
    emailIdentities: number;
    unsupportedProviderIdentities: number;
    invalidProviderIdentities: number;
    invalidIdentities: number;
    duplicateSubjects: number;
    usersWithMultipleGoogleIdentities: number;
  };
  accounts: {
    status: "available" | "unavailable" | "invalid";
    supabaseAuthUsers: number;
    invalidUsers: number;
    duplicateUserIds: number;
    liveD1UsersPresent: number;
    liveD1UsersMissing: number;
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
  passwords: NativePasswordMigrationEvidence;
  readyForBackfill: boolean;
  readyForGoogleCutover: boolean;
  readyForNativeAuthCutover: boolean;
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

function normaliseSourceAccount(value: SupabaseAuthAccount): string | null {
  const id = value.id;
  return typeof id === "string" && id.length >= 16 && id.length <= 80 ? id : null;
}

function unavailableReport(
  configured: NativeIdentityReadinessReport["configured"],
): NativeIdentityReadinessReport {
  return {
    generatedAt: new Date().toISOString(),
    configured,
    source: { status: "unavailable", googleIdentities: 0, appleIdentities: 0, emailIdentities: 0, unsupportedProviderIdentities: 0, invalidProviderIdentities: 0, invalidIdentities: 0, duplicateSubjects: 0, usersWithMultipleGoogleIdentities: 0 },
    accounts: { status: "unavailable", supabaseAuthUsers: 0, invalidUsers: 0, duplicateUserIds: 0, liveD1UsersPresent: 0, liveD1UsersMissing: 0 },
    target: { schema: "unavailable", sourceUsersPresent: 0, sourceUsersMissing: 0 },
    mappings: { correct: 0, missing: 0, mismatched: 0 },
    passwords: { status: "unavailable", sourceRows: null, importedRows: null, verifiedAt: null },
    readyForBackfill: false,
    readyForGoogleCutover: false,
    readyForNativeAuthCutover: false,
    blockers: ["Supabase Auth Google-identity evidence is unavailable"],
  };
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

async function targetAccountState(
  sourceUserIds: readonly string[],
  bindings: BandUpCloudflareBindings,
): Promise<Set<string>> {
  const liveUserIds = new Set<string>();
  for (const values of chunk(sourceUserIds)) {
    const rows = await bindings.db.prepare(`
      SELECT id FROM app_users
       WHERE deleted_at IS NULL AND id IN (${placeholders(values.length)})
    `).bind(...values).all<{ id: string }>();
    for (const row of rows.results) liveUserIds.add(row.id);
  }
  return liveUserIds;
}

/**
 * Private aggregate proof for the owner dashboard. No email, user id or Google
 * subject is returned, so checking readiness cannot become a directory API.
 */
export async function nativeIdentityReadinessReport(
  providedBindings?: BandUpCloudflareBindings,
  options: {
    readSource?: () => Promise<SupabaseGoogleIdentity[]>;
    readAccounts?: () => Promise<SupabaseAuthAccount[]>;
    readProviderSummary?: () => Promise<SupabaseAuthProviderSummary>;
  } = {},
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
  let rawAccounts: SupabaseAuthAccount[];
  let providerSummary: SupabaseAuthProviderSummary;
  try {
    rawSource = await (options.readSource ?? listSupabaseGoogleIdentities)();
    // A fixture that supplies only Google identities is used by focused unit
    // tests. It is not a production path, but deriving its account ids here
    // prevents the audit from making an accidental live source request.
    rawAccounts = options.readAccounts
      ? await options.readAccounts()
      : options.readSource
        ? rawSource.map((identity) => ({ id: identity.authUserId }))
        : await listSupabaseAuthAccounts();
    providerSummary = options.readProviderSummary
      ? await options.readProviderSummary()
      : options.readSource
        ? { google: rawSource.length, apple: 0, email: 0, unsupported: 0, invalid: 0 }
        : await listSupabaseAuthProviderSummary();
  } catch {
    /*
      Some Supabase Auth projects intentionally return `identities: null` to
      the Admin Users API. A temporary, service-role-only source RPC can give
      the migration the same immutable proof without weakening the public
      surface. Test fixtures keep their explicit source functions and never
      make this live fallback call.
    */
    if (options.readSource || options.readAccounts || options.readProviderSummary) {
      return unavailableReport(configured);
    }
    try {
      const fallback = await listSupabaseNativeIdentitySource();
      rawSource = fallback.googleIdentities;
      rawAccounts = fallback.accounts;
      providerSummary = fallback.providerSummary;
    } catch {
      return unavailableReport(configured);
    }
  }

  const valid = rawSource.flatMap((identity) => {
    const normalised = normaliseSourceIdentity(identity);
    return normalised ? [normalised] : [];
  });
  const validAccounts = rawAccounts.flatMap((account) => {
    const id = normaliseSourceAccount(account);
    return id ? [id] : [];
  });
  const accountIds = new Set<string>();
  let duplicateAccountIds = 0;
  for (const id of validAccounts) {
    if (accountIds.has(id)) duplicateAccountIds += 1;
    accountIds.add(id);
  }
  const invalidAccounts = rawAccounts.length - validAccounts.length;
  const accountStatus: NativeIdentityReadinessReport["accounts"]["status"] = invalidAccounts > 0
    ? "invalid"
    : "available";
  if (invalidAccounts > 0) blockers.push(`${invalidAccounts} Supabase Auth account record(s) have an invalid stable id`);
  if (duplicateAccountIds > 0) blockers.push(`${duplicateAccountIds} duplicate Supabase Auth user id(s) were returned by the source`);
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
  if (providerSummary.invalid > 0) blockers.push(`${providerSummary.invalid} legacy identity provider record(s) are invalid`);
  if (providerSummary.apple > 0) blockers.push(`${providerSummary.apple} Apple identity record(s) need a direct Cloudflare Apple OAuth migration`);
  if (providerSummary.unsupported > 0) blockers.push(`${providerSummary.unsupported} legacy identity provider record(s) use an unsupported provider`);

  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const schema = await targetSchema(bindings);
  if (schema !== "ready") {
    blockers.push(schema === "missing"
      ? "D1 identity migration 0015 has not been applied"
      : "D1 identity schema could not be checked");
    return {
      generatedAt: new Date().toISOString(),
      configured,
      source: { status: sourceStatus, googleIdentities: rawSource.length, appleIdentities: providerSummary.apple, emailIdentities: providerSummary.email, unsupportedProviderIdentities: providerSummary.unsupported, invalidProviderIdentities: providerSummary.invalid, invalidIdentities, duplicateSubjects, usersWithMultipleGoogleIdentities },
      accounts: { status: accountStatus, supabaseAuthUsers: rawAccounts.length, invalidUsers: invalidAccounts, duplicateUserIds: duplicateAccountIds, liveD1UsersPresent: 0, liveD1UsersMissing: 0 },
      target: { schema, sourceUsersPresent: 0, sourceUsersMissing: 0 },
      mappings: { correct: 0, missing: 0, mismatched: 0 },
      passwords: {
        status: schema === "missing" ? "missing" : "unavailable",
        sourceRows: null,
        importedRows: null,
        verifiedAt: null,
      },
      readyForBackfill: false,
      readyForGoogleCutover: false,
      readyForNativeAuthCutover: false,
      blockers,
    };
  }

  let state: Awaited<ReturnType<typeof targetIdentityState>>;
  let liveAccountIds: Set<string>;
  const passwords = providerSummary.email === 0
    ? { status: "verified" as const, sourceRows: 0, importedRows: 0, verifiedAt: null }
    : await nativePasswordMigrationEvidence(bindings);
  try {
    [state, liveAccountIds] = await Promise.all([
      targetIdentityState(valid, bindings),
      targetAccountState([...accountIds], bindings),
    ]);
  } catch {
    blockers.push("D1 identity or account records could not be checked");
    return {
      generatedAt: new Date().toISOString(),
      configured,
      source: { status: sourceStatus, googleIdentities: rawSource.length, appleIdentities: providerSummary.apple, emailIdentities: providerSummary.email, unsupportedProviderIdentities: providerSummary.unsupported, invalidProviderIdentities: providerSummary.invalid, invalidIdentities, duplicateSubjects, usersWithMultipleGoogleIdentities },
      accounts: { status: accountStatus, supabaseAuthUsers: rawAccounts.length, invalidUsers: invalidAccounts, duplicateUserIds: duplicateAccountIds, liveD1UsersPresent: 0, liveD1UsersMissing: 0 },
      target: { schema: "unavailable", sourceUsersPresent: 0, sourceUsersMissing: 0 },
      mappings: { correct: 0, missing: 0, mismatched: 0 },
      passwords,
      readyForBackfill: false,
      readyForGoogleCutover: false,
      readyForNativeAuthCutover: false,
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
  const liveD1UsersMissing = [...accountIds].filter((id) => !liveAccountIds.has(id)).length;
  if (sourceUsersMissing > 0) blockers.push(`${sourceUsersMissing} Supabase Google account(s) are missing a live D1 app_users record`);
  if (mismatched > 0) blockers.push(`${mismatched} existing D1 mapping(s) point to a different user id`);
  if (missing > 0) blockers.push(`${missing} Google identity mapping(s) still need an approved backfill`);
  if (liveD1UsersMissing > 0) blockers.push(`${liveD1UsersMissing} current Supabase Auth account(s) are missing a live D1 app_users record`);
  if (providerSummary.email > 0 && passwords.status !== "verified") {
    blockers.push("Legacy email/password credentials do not yet have an exact source-to-D1 migration certificate");
  }
  if (!configured.dataAuthority.ready) {
    blockers.push("learner and organization data must both be Cloudflare-authoritative before native sign-in can serve users");
  }
  const sourceClean = sourceStatus === "available" && duplicateSubjects === 0 && usersWithMultipleGoogleIdentities === 0;
  const accountsClean = accountStatus === "available" && duplicateAccountIds === 0 && liveD1UsersMissing === 0;
  const providersClean = providerSummary.apple === 0
    && providerSummary.unsupported === 0
    && providerSummary.invalid === 0
    && (providerSummary.email === 0 || passwords.status === "verified");
  const readyForBackfill = sourceClean && sourceUsersMissing === 0 && mismatched === 0;
  /*
    The normal Google Identity Services button posts its Google-issued ID
    token to /api/auth/google/token. That path verifies the token, then makes
    a D1 session directly; it does not use Supabase or the OAuth client
    secret. The confidential client secret enables an *additional*, full-page
    recovery path for browsers where the Google button cannot load. It must
    not make an otherwise safe Cloudflare-native Google cutover look blocked.
    The dashboard still exposes directGoogleServerFlow so the owner can see
    whether that optional resilience path is available.
  */
  const readyForGoogleCutover = readyForBackfill
    && missing === 0
    && correct === valid.length
    && accountsClean
    && configured.dataAuthority.ready;
  const readyForNativeAuthCutover = readyForGoogleCutover && providersClean;
  return {
    generatedAt: new Date().toISOString(),
    configured,
    source: { status: sourceStatus, googleIdentities: rawSource.length, appleIdentities: providerSummary.apple, emailIdentities: providerSummary.email, unsupportedProviderIdentities: providerSummary.unsupported, invalidProviderIdentities: providerSummary.invalid, invalidIdentities, duplicateSubjects, usersWithMultipleGoogleIdentities },
    accounts: {
      status: accountStatus,
      supabaseAuthUsers: rawAccounts.length,
      invalidUsers: invalidAccounts,
      duplicateUserIds: duplicateAccountIds,
      liveD1UsersPresent: accountIds.size - liveD1UsersMissing,
      liveD1UsersMissing,
    },
    target: { schema, sourceUsersPresent: users.size - sourceUsersMissing, sourceUsersMissing },
    mappings: { correct, missing, mismatched },
    passwords,
    readyForBackfill,
    readyForGoogleCutover,
    readyForNativeAuthCutover,
    blockers,
  };
}
