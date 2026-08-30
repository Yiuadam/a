import type { SessionUser } from "@/lib/auth/session";
import type { ProgressSnapshot } from "@/lib/auth/supabase";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";
import { clearAvatarObject, replaceAvatarObject } from "./avatar-storage";
import { CloudflareAccountDeletionInProgressError } from "./account-deletion";
import { readStoredJson, sha256, storeJson, type StoredJson } from "./payloads";
import {
  canonicalCloudflareSourceClock,
  currentCloudflareSourceClock,
} from "./source-clock";
import type {
  ProgressSnapshotExpectation,
  ProgressSnapshotMutation,
} from "@/lib/progress/server-snapshots";

export interface CloudflareLearnerProfile {
  displayName: string | null;
  username: string | null;
  accountKind: import("@/lib/auth/account-identity").AccountKind | null;
  avatarPath: string | null;
  birthDate: string | null;
  email: string | null;
  updatedAt: string | null;
}

interface ProgressRow {
  store_key: string;
  payload_inline: string | null;
  payload_object_key: string | null;
  payload_sha256: string;
  payload_bytes: number;
  client_updated_at: string | null;
}

interface LearnerProfileRow {
  display_name: string | null;
  username: string | null;
  account_kind: import("@/lib/auth/account-identity").AccountKind | null;
  birth_date: string | null;
  avatar_object_key: string | null;
  email: string | null;
  source_updated_at: string | null;
}

function now(): string {
  return currentCloudflareSourceClock();
}

/** Every deletion state, including preparation, freezes learner writes. */
export async function assertCloudflareAccountWritable(
  userId: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<void> {
  const { db } = providedBindings ?? await requireBandUpCloudflareBindings();
  const deletion = await db.prepare(`
    SELECT state FROM account_deletion_tombstones WHERE user_id = ?
  `).bind(userId).first<{ state: string }>();
  if (deletion) throw new CloudflareAccountDeletionInProgressError();
}

export async function ensureCloudflareUser(
  user: SessionUser,
  providedBindings?: BandUpCloudflareBindings,
): Promise<void> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const { db } = bindings;
  await assertCloudflareAccountWritable(user.id, bindings);
  const stamp = now();
  const createdAt = user.createdAt && Number.isFinite(Date.parse(user.createdAt))
    ? user.createdAt
    : stamp;
  try {
    const result = await db.prepare(`
      INSERT INTO app_users (id, email, role, created_at, updated_at)
      VALUES (?, ?, 'user', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        updated_at = excluded.updated_at,
        deleted_at = NULL
      WHERE app_users.email IS NOT excluded.email OR app_users.deleted_at IS NOT NULL
    `).bind(user.id, user.email, createdAt, stamp).run();
    if (!result.success) throw new Error("Cloudflare user bootstrap is unavailable");
  } catch (error) {
    // Convert the migration trigger's race-safe abort into the named error.
    await assertCloudflareAccountWritable(user.id, bindings);
    throw error;
  }
  // A preparation committed immediately after the upsert must still stop the
  // caller before it writes a child row or object.
  await assertCloudflareAccountWritable(user.id, bindings);
}

/**
 * Mirror the small, user-editable profile record into D1. Supabase Auth stays
 * the identity authority during the cutover; this copy keeps organization
 * rosters current when Cloudflare is the application-data authority.
 */
export async function putCloudflareLearnerProfile(
  user: SessionUser,
  profile: CloudflareLearnerProfile,
  providedBindings?: BandUpCloudflareBindings,
): Promise<boolean> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  await ensureCloudflareUser(user, bindings);
  const stamp = now();
  const sourceStamp = profile.updatedAt
    ? canonicalCloudflareSourceClock(profile.updatedAt)
    : stamp;
  const profileStatement = bindings.db.prepare(`
    INSERT INTO learner_profiles (
      user_id, display_name, birth_date, account_kind,
      source_updated_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM account_deletion_tombstones WHERE user_id = ?
     )
    ON CONFLICT(user_id) DO UPDATE SET
      display_name = excluded.display_name,
      birth_date = excluded.birth_date,
      account_kind = excluded.account_kind,
      source_updated_at = excluded.source_updated_at,
      updated_at = excluded.updated_at
    WHERE NOT EXISTS (
      SELECT 1 FROM account_deletion_tombstones WHERE user_id = excluded.user_id
    )
      AND (
        learner_profiles.source_updated_at IS NULL
        OR excluded.source_updated_at >= learner_profiles.source_updated_at
      )
  `).bind(
    user.id,
    profile.displayName,
    profile.birthDate,
    profile.accountKind,
    sourceStamp,
    stamp,
    user.id,
  );
  // Avatar bytes and their R2 pointer have a dedicated dual-write path. A
  // generic profile or avatar repair may race an exact username claim, so it
  // must never be allowed to roll the D1 alias back. It likewise must not
  // replace the private R2 pointer with a Supabase Storage path.
  const result = await profileStatement.run();
  await assertCloudflareAccountWritable(user.id, bindings);
  // Zero changes means a newer authoritative profile is already mirrored.
  return result.success;
}

/**
 * Create the D1 account/profile shell on the first authenticated profile read.
 * This is creation-only: a login can repair a missed bootstrap, but it cannot
 * roll an already-mirrored profile or username backwards.
 */
export async function bootstrapCloudflareLearnerProfile(
  user: SessionUser,
  profile: CloudflareLearnerProfile | null,
  providedBindings?: BandUpCloudflareBindings,
): Promise<boolean> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  await ensureCloudflareUser(user, bindings);
  const stamp = now();
  // A null profile may mean the Supabase read failed. Leave its source clock
  // null so the next successful authoritative read can always populate it.
  const sourceStamp = profile?.updatedAt ?? null;
  const statements = [bindings.db.prepare(`
    INSERT INTO learner_profiles (
      user_id, display_name, birth_date, account_kind, source_updated_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM account_deletion_tombstones WHERE user_id = ?
     )
    ON CONFLICT(user_id) DO NOTHING
  `).bind(
    user.id,
    profile?.displayName ?? null,
    profile?.birthDate ?? null,
    profile?.accountKind ?? null,
    sourceStamp,
    stamp,
    user.id,
  )];
  if (profile?.username) {
    statements.push(bindings.db.prepare(`
      INSERT INTO usernames (username, user_id, created_at, source_updated_at)
      SELECT ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM account_deletion_tombstones WHERE user_id = ?
       )
         AND NOT EXISTS (SELECT 1 FROM usernames WHERE user_id = ?)
      ON CONFLICT(username) DO NOTHING
    `).bind(profile.username, user.id, stamp, sourceStamp ?? stamp, user.id, user.id));
  }
  const results = await bindings.db.batch(statements);
  if (!results.every((result) => result.success)) return false;
  await assertCloudflareAccountWritable(user.id, bindings);
  const mirrored = await bindings.db.prepare(`
    SELECT p.user_id, n.username
      FROM learner_profiles p
      LEFT JOIN usernames n ON n.user_id = p.user_id
     WHERE p.user_id = ?
  `).bind(user.id).first<{ user_id: string; username: string | null }>();
  return mirrored?.user_id === user.id
    && (!profile?.username
      || mirrored.username?.toLocaleLowerCase("en") === profile.username.toLocaleLowerCase("en"));
}

/** The learner-owned profile in D1; Supabase Auth remains identity authority. */
export async function getCloudflareLearnerProfile(
  userId: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<CloudflareLearnerProfile | null> {
  const { db } = providedBindings ?? await requireBandUpCloudflareBindings();
  const row = await db.prepare(`
    SELECT p.display_name, p.birth_date, p.avatar_object_key, p.account_kind,
           p.source_updated_at,
           u.email, n.username
     FROM learner_profiles p
      JOIN app_users u ON u.id = p.user_id
      LEFT JOIN usernames n ON n.user_id = p.user_id
     WHERE p.user_id = ? AND u.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM account_deletion_tombstones d WHERE d.user_id = p.user_id
       )
  `).bind(userId).first<LearnerProfileRow>();
  if (!row) return null;
  return {
    displayName: row.display_name,
    username: row.username,
    accountKind: row.account_kind,
    birthDate: row.birth_date,
    avatarPath: row.avatar_object_key,
    email: row.email,
    updatedAt: row.source_updated_at,
  };
}

/** Strict focused read for preserving the retired account-kind value. */
export async function getCloudflareLearnerAccountKind(
  userId: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<import("@/lib/auth/account-identity").AccountKind | null> {
  const { db } = providedBindings ?? await requireBandUpCloudflareBindings();
  const row = await db.prepare(`
    SELECT account_kind FROM learner_profiles WHERE user_id = ?
  `).bind(userId).first<{ account_kind: import("@/lib/auth/account-identity").AccountKind | null }>();
  return row?.account_kind ?? null;
}

async function ensureCloudflareLearnerProfile(
  user: SessionUser,
  bindings: BandUpCloudflareBindings,
): Promise<void> {
  await ensureCloudflareUser(user, bindings);
  const stamp = now();
  const result = await bindings.db.prepare(`
    INSERT INTO learner_profiles (user_id, updated_at)
    SELECT ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM account_deletion_tombstones WHERE user_id = ?
     )
    ON CONFLICT(user_id) DO NOTHING
  `).bind(user.id, stamp, user.id).run();
  if (!result.success) throw new Error("Cloudflare learner profile is unavailable");
  await assertCloudflareAccountWritable(user.id, bindings);
}

/** Update only named fields so concurrent details/avatar saves cannot clobber. */
export async function updateCloudflareLearnerProfile(
  user: SessionUser,
  fields: Partial<Pick<CloudflareLearnerProfile, "displayName" | "birthDate">>,
  providedBindings?: BandUpCloudflareBindings,
): Promise<boolean> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  await ensureCloudflareLearnerProfile(user, bindings);
  const assignments: string[] = [];
  const values: (string | null)[] = [];
  if ("displayName" in fields) {
    assignments.push("display_name = ?");
    values.push(fields.displayName ?? null);
  }
  if ("birthDate" in fields) {
    assignments.push("birth_date = ?");
    values.push(fields.birthDate ?? null);
  }
  if (assignments.length === 0) return true;
  const stamp = now();
  assignments.push("source_updated_at = ?", "updated_at = ?");
  values.push(stamp, stamp, user.id);
  const result = await bindings.db.prepare(`
    UPDATE learner_profiles
       SET ${assignments.join(", ")}
     WHERE user_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM account_deletion_tombstones WHERE user_id = ?
       )
  `).bind(...values, user.id).run();
  return result.success && result.meta.changes === 1;
}

export type CloudflareAccountIdentityStatus = "ok" | "taken_username" | "unavailable";

export async function claimCloudflareUsername(
  user: SessionUser,
  username: string,
  sourceUpdatedAt?: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<CloudflareAccountIdentityStatus> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  await ensureCloudflareLearnerProfile(user, bindings);
  const stamp = now();
  const sourceStamp = sourceUpdatedAt
    ? canonicalCloudflareSourceClock(sourceUpdatedAt)
    : stamp;
  try {
    const results = await bindings.db.batch([
      bindings.db.prepare(`
        UPDATE usernames SET username = ?, source_updated_at = ?
         WHERE user_id = ? AND (
           source_updated_at IS NULL
           OR ? >= source_updated_at
         )
      `).bind(username, sourceStamp, user.id, sourceStamp),
      bindings.db.prepare(`
        INSERT INTO usernames (username, user_id, created_at, source_updated_at)
        SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM usernames WHERE user_id = ?)
      `).bind(username, user.id, stamp, sourceStamp, user.id),
    ]);
    return results.every((result) => result.success) ? "ok" : "unavailable";
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    return message.includes("unique") ? "taken_username" : "unavailable";
  }
}

/** Server-only username sign-in lookup; unknown and storage failure stay opaque. */
export async function emailForCloudflareUsername(
  username: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<string | null> {
  const { db } = providedBindings ?? await requireBandUpCloudflareBindings();
  const row = await db.prepare(`
    SELECT u.email
      FROM usernames n
      JOIN app_users u ON u.id = n.user_id
     WHERE n.username = ? COLLATE NOCASE AND u.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM account_deletion_tombstones d WHERE d.user_id = u.id
       )
     LIMIT 1
  `).bind(username).first<{ email: string | null }>();
  return row?.email ?? null;
}

/** Read-only parity check used after an authoritative Supabase username read. */
export async function cloudflareUsernameMatches(
  userId: string,
  username: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<boolean> {
  const { db } = providedBindings ?? await requireBandUpCloudflareBindings();
  const row = await db.prepare(`
    SELECT 1 AS matched
      FROM usernames n
      JOIN app_users u ON u.id = n.user_id
     WHERE n.user_id = ? AND n.username = ? COLLATE NOCASE
       AND u.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM account_deletion_tombstones d WHERE d.user_id = u.id
       )
     LIMIT 1
  `).bind(userId, username).first<{ matched: number }>();
  return row?.matched === 1;
}

/** A unique conflict is stale success only when this same account is newer. */
export async function cloudflareUsernameReplicaAtLeast(
  userId: string,
  sourceUpdatedAt: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<boolean> {
  const { db } = providedBindings ?? await requireBandUpCloudflareBindings();
  const sourceStamp = canonicalCloudflareSourceClock(sourceUpdatedAt);
  const row = await db.prepare(`
    SELECT 1 AS current FROM usernames
     WHERE user_id = ? AND source_updated_at >= ?
  `).bind(userId, sourceStamp).first<{ current: number }>();
  return row?.current === 1;
}

export async function setCloudflareAccountIdentity(
  user: SessionUser,
  identity: {
    displayName: string;
    username: string;
    accountKind: import("@/lib/auth/account-identity").AccountKind;
    birthDate: string | null;
  },
  sourceUpdatedAt?: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<CloudflareAccountIdentityStatus> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  await ensureCloudflareLearnerProfile(user, bindings);
  const stamp = now();
  const sourceStamp = sourceUpdatedAt
    ? canonicalCloudflareSourceClock(sourceUpdatedAt)
    : stamp;
  try {
    const results = await bindings.db.batch([
      bindings.db.prepare(`
        UPDATE usernames SET username = ?, source_updated_at = ?
         WHERE user_id = ? AND (
           source_updated_at IS NULL
           OR ? >= source_updated_at
         )
      `).bind(identity.username, sourceStamp, user.id, sourceStamp),
      bindings.db.prepare(`
        INSERT INTO usernames (username, user_id, created_at, source_updated_at)
        SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM usernames WHERE user_id = ?)
      `).bind(identity.username, user.id, stamp, sourceStamp, user.id),
      bindings.db.prepare(`
        UPDATE learner_profiles
           SET display_name = ?, account_kind = ?, birth_date = ?,
               source_updated_at = ?, updated_at = ?
         WHERE user_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM account_deletion_tombstones WHERE user_id = ?
           )
           AND (
             source_updated_at IS NULL
             OR ? >= source_updated_at
           )
      `).bind(
        identity.displayName,
        identity.accountKind,
        identity.birthDate,
        sourceStamp,
        stamp,
        user.id,
        user.id,
        sourceStamp,
      ),
    ]);
    return results.every((result) => result.success) ? "ok" : "unavailable";
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    return message.includes("unique") ? "taken_username" : "unavailable";
  }
}

export async function setCloudflareAvatarObjectKey(
  user: SessionUser,
  objectKey: string | null,
  expectedObjectKey: string | null,
  sourceUpdatedAt?: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<boolean> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  await ensureCloudflareLearnerProfile(user, bindings);
  const stamp = now();
  const sourceStamp = sourceUpdatedAt
    ? canonicalCloudflareSourceClock(sourceUpdatedAt)
    : stamp;
  const result = await bindings.db.prepare(`
    UPDATE learner_profiles
       SET avatar_object_key = ?,
           avatar_source_updated_at = ?,
           source_updated_at = CASE
             WHEN source_updated_at IS NULL
               OR ? >= source_updated_at
             THEN ? ELSE source_updated_at END,
           updated_at = ?
     WHERE user_id = ? AND avatar_object_key IS ?
       AND (
         avatar_source_updated_at IS NULL
         OR ? >= avatar_source_updated_at
       )
       AND NOT EXISTS (
         SELECT 1 FROM account_deletion_tombstones WHERE user_id = ?
       )
  `).bind(
    objectKey,
    sourceStamp,
    sourceStamp,
    sourceStamp,
    stamp,
    user.id,
    expectedObjectKey,
    sourceStamp,
    user.id,
  ).run();
  return result.success && result.meta.changes === 1;
}

/** A rejected avatar CAS is a successful stale replay when D1 is newer. */
export async function cloudflareAvatarReplicaAtLeast(
  userId: string,
  sourceUpdatedAt: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<boolean> {
  const { db } = providedBindings ?? await requireBandUpCloudflareBindings();
  const sourceStamp = canonicalCloudflareSourceClock(sourceUpdatedAt);
  const row = await db.prepare(`
    SELECT 1 AS current
      FROM learner_profiles
     WHERE user_id = ? AND avatar_source_updated_at >= ?
  `).bind(userId, sourceStamp).first<{ current: number }>();
  return row?.current === 1;
}

function safeObjectSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
}

export interface CloudflareAvatarWrite {
  success: boolean;
  objectKey: string | null;
}

/** Store immutable bytes, commit their D1 pointer, then retire the old blob. */
export async function putCloudflareAvatar(
  user: SessionUser,
  body: ArrayBuffer,
  kind: { ext: string; mime: string },
  providedBindings?: BandUpCloudflareBindings,
  onObjectCleanupNeeded?: (key: string) => Promise<void>,
  sourceUpdatedAt?: string,
): Promise<CloudflareAvatarWrite> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const previous = await getCloudflareLearnerProfile(user.id, bindings);
  const digest = await sha256(new Uint8Array(body));
  const objectKey = `private/avatars/${safeObjectSegment(user.id)}/${digest}.${kind.ext}`;
  const success = await replaceAvatarObject({
    previousKey: previous?.avatarPath ?? null,
    nextKey: objectKey,
    storeNext: async () => {
      await assertCloudflareAccountWritable(user.id, bindings);
      await bindings.files.put(objectKey, body, {
        httpMetadata: {
          contentType: kind.mime,
          cacheControl: "private, max-age=31536000, immutable",
        },
        customMetadata: { sha256: digest },
      });
      try {
        // Close the prepare/list race: deletion may have begun while R2 was
        // accepting the body, before the pointer exists for its manifest.
        await assertCloudflareAccountWritable(user.id, bindings);
      } catch (error) {
        if (objectKey !== previous?.avatarPath) {
          await bindings.files.delete(objectKey).catch(() => undefined);
        }
        throw error;
      }
    },
    setPointer: (key) => setCloudflareAvatarObjectKey(
      user,
      key,
      previous?.avatarPath ?? null,
      sourceUpdatedAt,
      bindings,
    ),
    deleteObject: (key) => bindings.files.delete(key),
    onDeleteFailure: onObjectCleanupNeeded,
  });
  return { success, objectKey: success ? objectKey : null };
}

/** Clear D1 first so an R2 delete can never leave a live broken pointer. */
export async function deleteCloudflareAvatar(
  user: SessionUser,
  providedBindings?: BandUpCloudflareBindings,
  onObjectCleanupNeeded?: (key: string) => Promise<void>,
  sourceUpdatedAt?: string,
): Promise<boolean> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const previous = await getCloudflareLearnerProfile(user.id, bindings);
  return clearAvatarObject({
    previousKey: previous?.avatarPath ?? null,
    clearPointer: () => setCloudflareAvatarObjectKey(
      user,
      null,
      previous?.avatarPath ?? null,
      sourceUpdatedAt,
      bindings,
    ),
    deleteObject: (key) => bindings.files.delete(key),
    onDeleteFailure: onObjectCleanupNeeded,
  });
}

/**
 * Resolve only the key named by both the signed grant and the live D1 pointer.
 * R2 itself stays private and has no public/custom-domain URL.
 */
export async function getCloudflareAvatarObject(
  userId: string,
  objectKey: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<R2ObjectBody | null> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const row = await bindings.db.prepare(`
    SELECT p.avatar_object_key
     FROM learner_profiles p
      JOIN app_users u ON u.id = p.user_id
     WHERE p.user_id = ? AND u.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM account_deletion_tombstones d WHERE d.user_id = p.user_id
       )
  `).bind(userId).first<{ avatar_object_key: string | null }>();
  if (!row?.avatar_object_key || row.avatar_object_key !== objectKey) return null;
  return bindings.files.get(objectKey);
}

export async function getCloudflareProgressSnapshots(
  user: SessionUser,
  providedBindings?: BandUpCloudflareBindings,
): Promise<ProgressSnapshot[]> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  await ensureCloudflareUser(user, bindings);
  const rows = await bindings.db.prepare(`
    SELECT store_key, payload_inline, payload_object_key, payload_sha256,
           payload_bytes, client_updated_at
      FROM progress_snapshots
     WHERE user_id = ?
     ORDER BY store_key
  `).bind(user.id).all<ProgressRow>();

  const snapshots: ProgressSnapshot[] = [];
  for (const row of rows.results) {
    const stored: StoredJson = {
      inline: row.payload_inline,
      objectKey: row.payload_object_key,
      sha256: row.payload_sha256,
      bytes: row.payload_bytes,
    };
    snapshots.push({
      storeKey: row.store_key,
      payload: await readStoredJson(bindings, stored),
      clientUpdatedAt: row.client_updated_at,
    });
  }
  return snapshots;
}

export type CloudflareProgressCasResult =
  | { status: "committed"; at: string }
  | { status: "conflict" };

function uniqueProgressBatch(
  expected: ProgressSnapshotExpectation[],
  snapshots: ProgressSnapshotMutation[],
): boolean {
  if (snapshots.length < 1 || snapshots.length > 3 || expected.length !== snapshots.length) {
    return false;
  }
  const expectedKeys = new Set(expected.map((item) => item.storeKey));
  const snapshotKeys = new Set(snapshots.map((item) => item.storeKey));
  return expectedKeys.size === expected.length
    && snapshotKeys.size === snapshots.length
    && [...expectedKeys].every((key) => snapshotKeys.has(key))
    && expected.every((item) => item.exists
      ? item.clientUpdatedAt !== null
      : item.clientUpdatedAt === null);
}

/**
 * Atomically compare and replace a complete submitted progress batch in D1.
 *
 * R2 bodies are immutable and content-addressed, so they can safely be
 * prepared before the D1 pointer swap. The single INSERT statement guards all
 * keys against the payloads the route merged; if another device committed in
 * between the read and this statement, zero rows change and the route retries
 * from the newer state. A D1 failure cannot leave only one sync key committed.
 */
export async function compareAndSwapCloudflareProgressSnapshots(
  user: SessionUser,
  expected: ProgressSnapshotExpectation[],
  snapshots: ProgressSnapshotMutation[],
  providedBindings?: BandUpCloudflareBindings,
): Promise<CloudflareProgressCasResult> {
  if (!uniqueProgressBatch(expected, snapshots)) {
    throw new Error("Invalid Cloudflare progress batch");
  }
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  await ensureCloudflareUser(user, bindings);
  const stored = await Promise.all(snapshots.map(async (snapshot) => ({
    ...snapshot,
    stored: await storeJson(
      bindings,
      `progress/${snapshot.storeKey}`,
      user.id,
      snapshot.payload,
    ),
  })));
  const stamp = now();
  const valuesSql = stored.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
  const values = stored.flatMap((snapshot) => [
    user.id,
    snapshot.storeKey,
    snapshot.stored.inline,
    snapshot.stored.objectKey,
    snapshot.stored.sha256,
    snapshot.stored.bytes,
    stamp,
    stamp,
    stamp,
    stamp,
  ]);
  const expectedValuesSql = expected.map(() => "(?, ?, ?)").join(", ");
  const expectedValues = expected.flatMap((item) => [
    item.storeKey,
    item.exists ? 1 : 0,
    item.clientUpdatedAt,
  ]);

  const statements = await bindings.db.batch([
    bindings.db.prepare(`
    WITH expected (store_key, expected_exists, expected_updated_at) AS (
      VALUES ${expectedValuesSql}
    )
    SELECT count(*) AS conflict_count
      FROM expected
      LEFT JOIN progress_snapshots current
        ON current.user_id = ? AND current.store_key = expected.store_key
     WHERE (expected.expected_exists = 1 AND (
              current.user_id IS NULL
              OR current.client_updated_at IS NOT expected.expected_updated_at
           ))
        OR (expected.expected_exists = 0 AND current.user_id IS NOT NULL)
  `).bind(...expectedValues, user.id),
    bindings.db.prepare(`
    WITH expected (store_key, expected_exists, expected_updated_at) AS (
      VALUES ${expectedValuesSql}
    ), candidate (
      user_id, store_key, payload_inline, payload_object_key, payload_sha256,
      payload_bytes, client_updated_at, source_updated_at, created_at, updated_at
    ) AS (VALUES ${valuesSql})
    INSERT INTO progress_snapshots (
      user_id, store_key, payload_inline, payload_object_key, payload_sha256,
      payload_bytes, client_updated_at, source_updated_at, created_at, updated_at
    )
    SELECT user_id, store_key, payload_inline, payload_object_key, payload_sha256,
           payload_bytes, client_updated_at, source_updated_at, created_at, updated_at
      FROM candidate
     WHERE NOT EXISTS (
       SELECT 1
         FROM expected
         LEFT JOIN progress_snapshots current
           ON current.user_id = ? AND current.store_key = expected.store_key
        WHERE (expected.expected_exists = 1 AND (
                 current.user_id IS NULL
                 OR current.client_updated_at IS NOT expected.expected_updated_at
              ))
           OR (expected.expected_exists = 0 AND current.user_id IS NOT NULL)
     )
       AND NOT EXISTS (
         SELECT 1 FROM account_deletion_tombstones WHERE user_id = ?
       )
    ON CONFLICT(user_id, store_key) DO UPDATE SET
      payload_inline = excluded.payload_inline,
      payload_object_key = excluded.payload_object_key,
      payload_sha256 = excluded.payload_sha256,
      payload_bytes = excluded.payload_bytes,
      client_updated_at = excluded.client_updated_at,
      source_updated_at = excluded.source_updated_at,
      updated_at = excluded.updated_at
  `).bind(...expectedValues, ...values, user.id, user.id),
  ]);
  const [checked, result] = statements;
  if (!checked?.success || !result?.success) {
    throw new Error("Cloudflare progress batch is unavailable");
  }
  const conflictCount = Number(
    (checked.results?.[0] as { conflict_count?: unknown } | undefined)?.conflict_count ?? -1,
  );
  if (conflictCount > 0) {
    if (result.meta.changes !== 0) {
      throw new Error("Cloudflare progress conflict changed rows");
    }
    return { status: "conflict" };
  }
  if (conflictCount !== 0 || result.meta.changes !== snapshots.length) {
    throw new Error("Cloudflare progress batch changed an unexpected row count");
  }
  return { status: "committed", at: stamp };
}

/**
 * Delete named progress rows for one learner in D1.
 *
 * The R2 body a deleted row pointed at is deliberately left alone. Those
 * objects are immutable and content-addressed, so the same bytes can be
 * shared by another row or another learner's identical payload, and deleting
 * one out from under a live pointer would turn a cleared record into a broken
 * one. lib/cloudflare/organization-attempt-objects.ts already owns
 * unreferenced-object collection; this stays a pointer delete.
 *
 * Idempotent: a row that is already gone deletes cleanly, which is what makes
 * this safe for the caller to retry on a later clear.
 */
export async function deleteCloudflareProgressSnapshots(
  user: SessionUser,
  storeKeys: string[],
  providedBindings?: BandUpCloudflareBindings,
): Promise<boolean> {
  if (storeKeys.length === 0) return true;
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const placeholders = storeKeys.map(() => "?").join(", ");
  const result = await bindings.db.prepare(`
    DELETE FROM progress_snapshots
     WHERE user_id = ? AND store_key IN (${placeholders})
  `).bind(user.id, ...storeKeys).run();
  return result.success === true;
}

/**
 * The one guarded upsert both the live mirror and the drift backfill write:
 * never for a tombstoned account, never rolling `source_updated_at` back.
 */
async function applyCloudflareProgressSnapshots(
  userId: string,
  snapshots: ProgressSnapshotMutation[],
  sourceUpdatedAt: string,
  bindings: BandUpCloudflareBindings,
): Promise<boolean> {
  const sourceStamp = canonicalCloudflareSourceClock(sourceUpdatedAt);
  const stored = await Promise.all(snapshots.map(async (snapshot) => ({
    ...snapshot,
    stored: await storeJson(
      bindings,
      `progress/${snapshot.storeKey}`,
      userId,
      snapshot.payload,
    ),
  })));
  const stamp = now();
  const valuesSql = stored.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
  const values = stored.flatMap((snapshot) => [
    userId,
    snapshot.storeKey,
    snapshot.stored.inline,
    snapshot.stored.objectKey,
    snapshot.stored.sha256,
    snapshot.stored.bytes,
    sourceStamp,
    sourceStamp,
    stamp,
    stamp,
  ]);
  const result = await bindings.db.prepare(`
    WITH candidate (
      user_id, store_key, payload_inline, payload_object_key, payload_sha256,
      payload_bytes, client_updated_at, source_updated_at, created_at, updated_at
    ) AS (VALUES ${valuesSql})
    INSERT INTO progress_snapshots (
      user_id, store_key, payload_inline, payload_object_key, payload_sha256,
      payload_bytes, client_updated_at, source_updated_at, created_at, updated_at
    )
    SELECT user_id, store_key, payload_inline, payload_object_key, payload_sha256,
           payload_bytes, client_updated_at, source_updated_at, created_at, updated_at
      FROM candidate
     WHERE NOT EXISTS (
       SELECT 1 FROM account_deletion_tombstones WHERE user_id = ?
     )
    ON CONFLICT(user_id, store_key) DO UPDATE SET
      payload_inline = excluded.payload_inline,
      payload_object_key = excluded.payload_object_key,
      payload_sha256 = excluded.payload_sha256,
      payload_bytes = excluded.payload_bytes,
      client_updated_at = excluded.client_updated_at,
      source_updated_at = excluded.source_updated_at,
      updated_at = excluded.updated_at
    WHERE progress_snapshots.source_updated_at IS NULL
       OR excluded.source_updated_at >= progress_snapshots.source_updated_at
  `).bind(...values, userId).run();
  return result.success && result.meta.changes === snapshots.length;
}

/**
 * Mirror one committed Supabase batch without allowing a delayed older
 * request to overwrite a newer D1 replica.
 */
export async function replicateCloudflareProgressSnapshots(
  user: SessionUser,
  snapshots: ProgressSnapshotMutation[],
  sourceUpdatedAt: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<boolean> {
  if (snapshots.length < 1 || snapshots.length > 3
    || new Set(snapshots.map((item) => item.storeKey)).size !== snapshots.length) {
    return false;
  }
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  await ensureCloudflareUser(user, bindings);
  return applyCloudflareProgressSnapshots(user.id, snapshots, sourceUpdatedAt, bindings);
}

/**
 * Writes one drifted progress row for the backfill, without
 * `ensureCloudflareUser`'s side effect of overwriting `app_users.email`.
 *
 * See `backfillCloudflareUsageEvent` in usage-cost-replica.ts for why: this
 * has no session, only a row domain-drift.ts already named as wrong, and the
 * account's real current email belongs to the profile mirror, not to this
 * write. The caller bootstraps a bare `app_users` row with `INSERT OR IGNORE`
 * beforehand when one does not exist, which never touches an existing row.
 * The tombstone guard and the "never roll `source_updated_at` back" guard
 * above are unchanged and still apply.
 */
export async function backfillCloudflareProgressSnapshot(
  userId: string,
  snapshot: ProgressSnapshotMutation,
  sourceUpdatedAt: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<boolean> {
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  return applyCloudflareProgressSnapshots(userId, [snapshot], sourceUpdatedAt, bindings);
}
