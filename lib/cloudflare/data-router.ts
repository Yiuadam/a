import type { SessionUser } from "@/lib/auth/session";
import {
  getProfile as getSupabaseLearnerProfile,
  getAccountKind as getSupabaseLearnerAccountKind,
  getProgressSnapshots as getSupabaseProgressSnapshots,
  updateProfile as updateSupabaseLearnerProfile,
  setAccountIdentity as setSupabaseAccountIdentity,
  claimUsername as claimSupabaseUsername,
  emailForUsername as emailForSupabaseUsername,
  compareAndSwapProgressSnapshots,
  deleteProgressSnapshots as deleteSupabaseProgressSnapshots,
  type Profile,
  type ProgressSnapshot,
} from "@/lib/auth/supabase";
import { cloudflareDataMode, organizationDataMode } from "./bindings";
import {
  getCloudflareLearnerProfile,
  getCloudflareLearnerAccountKind,
  getCloudflareProgressSnapshots,
  updateCloudflareLearnerProfile,
  setCloudflareAccountIdentity,
  claimCloudflareUsername,
  emailForCloudflareUsername,
  cloudflareUsernameMatches,
  compareAndSwapCloudflareProgressSnapshots,
  deleteCloudflareProgressSnapshots,
} from "./learner-data";
import {
  replicateAccountIdentityDurably,
  replicateLearnerProfileDurably,
  replicateProgressDurably,
  replicateUsernameDurably,
} from "./replica-replay";
import type {
  ProgressSnapshotExpectation,
  ProgressSnapshotMutation,
} from "@/lib/progress/server-snapshots";

export interface ReplicatedWrite {
  primary: boolean;
  cloudflareReplica: boolean | null;
}

/**
 * Organization views join D1 profiles even while learner data remains
 * Supabase-authoritative. Keep those small shared records fresh whenever
 * either cutover domain is actively using Cloudflare.
 */
function cloudflareProfileReplicaEnabled(): boolean {
  return cloudflareDataMode() !== "supabase" || organizationDataMode() !== "supabase";
}

/**
 * Route learner-owned profile reads to the selected authority. Identity still
 * comes from the already-verified Supabase Auth user passed by the caller.
 */
export async function getLearnerProfile(user: SessionUser): Promise<Profile | null> {
  if (cloudflareDataMode() === "cloudflare") {
    return getCloudflareLearnerProfile(user.id);
  }
  // An authoritative read is also a reconciliation opportunity. The durable
  // task and target write both carry Supabase's source clock, so a delayed
  // login can repair a missed mirror without rolling newer D1 data backwards.
  const profile = await getSupabaseLearnerProfile(user.id);
  if (profile && cloudflareProfileReplicaEnabled()) {
    try {
      if (!(await replicateLearnerProfileDurably(user, profile))) {
        console.error("[accounts] profile Cloudflare reconciliation: replica verification failed");
      }
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error(`[accounts] profile Cloudflare reconciliation: ${detail}`);
    }
  }
  return profile;
}

/** A strict, focused read used only to preserve retired profile metadata. */
export async function getLearnerAccountKind(
  user: SessionUser,
): Promise<import("@/lib/auth/account-identity").AccountKind | null> {
  return cloudflareDataMode() === "cloudflare"
    ? getCloudflareLearnerAccountKind(user.id)
    : getSupabaseLearnerAccountKind(user.id);
}

/** Resolve a sign-in alias from the same authority that owns usernames. */
export async function emailForLearnerUsername(username: string): Promise<string | null> {
  if (cloudflareDataMode() === "cloudflare") {
    try {
      return await emailForCloudflareUsername(username);
    } catch {
      return null;
    }
  }
  return emailForSupabaseUsername(username);
}

/**
 * `false` means the organization replica is definitely missing or divergent;
 * `null` means it could not be checked, which must not make the whole learning
 * app unavailable merely because organization search is temporarily offline.
 */
export async function learnerUsernameReplicaReady(
  userId: string,
  username: string | null,
): Promise<boolean | null> {
  if (!username) return false;
  if (!cloudflareProfileReplicaEnabled()) return true;
  try {
    return await cloudflareUsernameMatches(userId, username);
  } catch {
    return null;
  }
}

/**
 * Profile details are primary in D1 only after learner cutover. While
 * Supabase is primary, the complete stored row is mirrored when either the
 * learner cutover is dual or the organization domain uses Cloudflare.
 */
export async function updateLearnerProfile(
  user: SessionUser,
  fields: Partial<Pick<Profile, "displayName" | "birthDate">>,
): Promise<ReplicatedWrite> {
  const mode = cloudflareDataMode();
  if (mode === "cloudflare") {
    try {
      return {
        primary: await updateCloudflareLearnerProfile(user, fields),
        cloudflareReplica: null,
      };
    } catch {
      return { primary: false, cloudflareReplica: null };
    }
  }

  const primary = await updateSupabaseLearnerProfile(user.id, fields);
  if (!primary || !cloudflareProfileReplicaEnabled()) {
    return { primary, cloudflareReplica: null };
  }
  const stored = await getSupabaseLearnerProfile(user.id);
  if (!stored) return { primary, cloudflareReplica: false };
  return {
    primary,
    cloudflareReplica: await replicateLearnerProfile(user, stored),
  };
}

export type LearnerAccountIdentityStatus =
  | "ok"
  | "invalid_display_name"
  | "invalid_account_kind"
  | "invalid_username"
  | "reserved_username"
  | "taken_username"
  | "missing_profile"
  | "unavailable";

export async function setLearnerAccountIdentity(
  user: SessionUser,
  identity: {
    displayName: string;
    username: string;
    accountKind: import("@/lib/auth/account-identity").AccountKind;
    birthDate: string | null;
  },
): Promise<{ status: LearnerAccountIdentityStatus; cloudflareReplica: boolean | null }> {
  const mode = cloudflareDataMode();
  if (mode === "cloudflare") {
    try {
      return { status: await setCloudflareAccountIdentity(user, identity), cloudflareReplica: null };
    } catch {
      return { status: "unavailable", cloudflareReplica: null };
    }
  }

  let status: LearnerAccountIdentityStatus;
  try {
    status = await setSupabaseAccountIdentity(
      user.id,
      identity.displayName,
      identity.username,
      identity.accountKind,
      identity.birthDate,
    );
  } catch {
    return { status: "unavailable", cloudflareReplica: null };
  }
  if (status !== "ok" || !cloudflareProfileReplicaEnabled()) {
    return { status, cloudflareReplica: null };
  }
  /*
    Five paths set cloudflareReplica false and three of them used to say
    nothing at all, so a caller saw one indistinguishable failure and an hour
    went into narrowing it by hand. Each now names itself. The identifiers are
    fixed strings chosen here, never an upstream message, so nothing about the
    database reaches a log that a person reads.
  */
  const stored = await getSupabaseLearnerProfile(user.id).catch((error) => {
    console.error(JSON.stringify({
      message: "identity replica: profile read-back threw",
      error: error instanceof Error ? error.message : String(error),
    }));
    return null;
  });
  if (!stored) {
    console.error(JSON.stringify({ message: "identity replica: profile read-back returned nothing" }));
    return { status, cloudflareReplica: false };
  }
  if (!stored.updatedAt) {
    console.error(JSON.stringify({ message: "identity replica: profile has no source clock" }));
    return { status, cloudflareReplica: false };
  }
  try {
    const mirrored = await replicateAccountIdentityDurably(user, identity, stored.updatedAt);
    if (!mirrored) {
      console.error(JSON.stringify({ message: "identity replica: mirror reported failure" }));
    }
    return { status, cloudflareReplica: mirrored };
  } catch (error) {
    console.error(JSON.stringify({
      message: "identity replica: mirror threw",
      error: error instanceof Error ? error.message : String(error),
    }));
    return { status, cloudflareReplica: false };
  }
}

export async function claimLearnerUsername(
  user: SessionUser,
  username: string,
): Promise<{ status: LearnerAccountIdentityStatus; cloudflareReplica: boolean | null }> {
  const mode = cloudflareDataMode();
  if (mode === "cloudflare") {
    try {
      return {
        status: await claimCloudflareUsername(user, username),
        cloudflareReplica: null,
      };
    } catch {
      return { status: "unavailable", cloudflareReplica: null };
    }
  }

  let claimed: Awaited<ReturnType<typeof claimSupabaseUsername>>;
  try {
    claimed = await claimSupabaseUsername(user.id, username);
  } catch {
    return { status: "unavailable", cloudflareReplica: null };
  }
  const status: LearnerAccountIdentityStatus = claimed === "taken"
    ? "taken_username"
    : claimed === "invalid"
      ? "invalid_username"
      : claimed === "reserved"
        ? "reserved_username"
        : "ok";
  if (status !== "ok" || !cloudflareProfileReplicaEnabled()) {
    return { status, cloudflareReplica: null };
  }
  const stored = await getSupabaseLearnerProfile(user.id).catch(() => null);
  if (!stored?.updatedAt) return { status, cloudflareReplica: false };
  try {
    return {
      status,
      cloudflareReplica: await replicateUsernameDurably(user, username, stored.updatedAt),
    };
  } catch {
    return { status, cloudflareReplica: false };
  }
}

/**
 * Re-attempt the username copy into D1 after it has been found behind.
 *
 * The claim above reports a failed replica rather than throwing, because the
 * authoritative write has already succeeded and refusing the learner over a
 * copy would be the wrong trade — see the note at that call site in
 * app/api/account/profile/route.ts. Something still has to close the gap, and
 * this is it: the profile read calls it whenever it notices the replica is
 * not ready, which makes an outage self-healing the next time the learner
 * opens any page that loads their profile.
 *
 * Best effort by construction. It answers false rather than throwing, because
 * every caller is a repair running after a response has already been sent.
 */
export async function repairLearnerUsernameReplica(
  user: SessionUser,
  username: string | null,
): Promise<boolean> {
  if (!username || !cloudflareProfileReplicaEnabled()) return false;
  if (cloudflareDataMode() === "cloudflare") return false;
  const stored = await getSupabaseLearnerProfile(user.id).catch(() => null);
  if (!stored?.updatedAt) return false;
  try {
    return await replicateUsernameDurably(user, username, stored.updatedAt);
  } catch {
    return false;
  }
}

/**
 * Keep organization-facing profile fields current during and after cutover.
 * A Cloudflare organization mode requests this replica independently of the
 * learner-data mode. A failure is reported separately so a durable Supabase
 * save remains successful and a later save/copy can repair the replica.
 */
export async function replicateLearnerProfile(
  user: SessionUser,
  profile: Profile,
): Promise<boolean | null> {
  if (!cloudflareProfileReplicaEnabled()) return null;
  try {
    return await replicateLearnerProfileDurably(user, profile);
  } catch {
    return false;
  }
}

/**
 * Supabase remains the read authority while copies are being compared. This
 * intentionally does not merge an unverified D1 copy into a learner's live
 * account: migration correctness is proven by the verifier, not guessed on a
 * request path.
 */
export async function getLearnerProgressSnapshots(
  user: SessionUser,
): Promise<ProgressSnapshot[] | null> {
  const mode = cloudflareDataMode();
  if (mode === "cloudflare") {
    try {
      return await getCloudflareProgressSnapshots(user);
    } catch {
      return null;
    }
  }
  return getSupabaseProgressSnapshots(user.id);
}

/**
 * Delete progress rows outright, rather than leaving them present and empty.
 *
 * Used by app/api/account/progress/route.ts once a clear has been committed,
 * and only for the rows that carry no clear tombstone of their own — see the
 * WHY note at that call site for why the profile row is never among them.
 *
 * True only if every authority that holds a copy dropped them. In dual mode
 * that deliberately includes the D1 replica: a row left behind there is a
 * copy of the learner's cleared work still sitting in a second provider, and
 * reporting success for it would be the same half-kept promise the emptied
 * row was. The caller degrades to the emptied-row behaviour on false, so an
 * honest false costs a learner nothing beyond a row that is already empty.
 */
export async function deleteLearnerProgressRows(
  user: SessionUser,
  storeKeys: string[],
): Promise<boolean> {
  if (storeKeys.length === 0) return true;
  const mode = cloudflareDataMode();
  if (mode === "cloudflare") {
    try {
      return await deleteCloudflareProgressSnapshots(user, storeKeys);
    } catch {
      return false;
    }
  }

  const primary = await deleteSupabaseProgressSnapshots(user.id, storeKeys);
  if (mode !== "dual") return primary;

  let replica = false;
  try {
    replica = await deleteCloudflareProgressSnapshots(user, storeKeys);
  } catch {
    replica = false;
  }
  return primary && replica;
}

/**
 * In dual mode Supabase is written first. A Cloudflare replication failure is
 * reported separately and never turns a successful learner save into a false
 * failure. The migration monitor can replay it idempotently before cutover.
 */
export type LearnerProgressCasResult =
  | { status: "committed"; at: string; cloudflareReplica: boolean | null }
  | { status: "conflict" }
  | { status: "unavailable" };

/** Commit an all-or-nothing progress batch against the rows the route read. */
export async function compareAndSwapLearnerProgressSnapshots(
  user: SessionUser,
  expected: ProgressSnapshotExpectation[],
  snapshots: ProgressSnapshotMutation[],
): Promise<LearnerProgressCasResult> {
  const mode = cloudflareDataMode();
  if (mode === "cloudflare") {
    try {
      const result = await compareAndSwapCloudflareProgressSnapshots(
        user,
        expected,
        snapshots,
      );
      return result.status === "committed"
        ? { ...result, cloudflareReplica: null }
        : result;
    } catch {
      return { status: "unavailable" };
    }
  }

  const primary = await compareAndSwapProgressSnapshots(
    user.id,
    expected,
    snapshots,
  );
  if (primary.status !== "committed") return primary;
  if (mode !== "dual") return { ...primary, cloudflareReplica: null };

  try {
    return {
      ...primary,
      cloudflareReplica: await replicateProgressDurably(
        user,
        snapshots,
        primary.at,
      ),
    };
  } catch {
    return { ...primary, cloudflareReplica: false };
  }
}
