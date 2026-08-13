import type { SessionUser } from "@/lib/auth/session";
import type {
  Profile,
  StripeSubscriptionReplica,
} from "@/lib/auth/supabase";
import type { ProgressSnapshotMutation } from "@/lib/progress/server-snapshots";
import type { StripeReplicaEvent } from "./billing-replica";
import {
  replicateAuthoritativeStripeState,
} from "./billing-replica";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";
import {
  claimCloudflareUsername,
  cloudflareAvatarReplicaAtLeast,
  cloudflareUsernameReplicaAtLeast,
  deleteCloudflareAvatar,
  putCloudflareAvatar,
  putCloudflareLearnerProfile,
  replicateCloudflareProgressSnapshots,
  setCloudflareAccountIdentity,
} from "./learner-data";
import {
  acknowledgeCloudflareReplicaTask,
  drainCloudflareReplicaOutbox,
  enqueueCloudflareObjectCleanup,
  enqueueCloudflareReplicaTask,
  type CloudflareReplicaTask,
} from "./replica-outbox";
import {
  mirrorCloudflareAiCostCoverage,
  mirrorCloudflareAiCostEvent,
  mirrorCloudflareUsageEvent,
  type CloudflareAiCostCoverageReplica,
  type CloudflareAiCostEventReplica,
  type CloudflareUsageEventReplica,
} from "./usage-cost-replica";
import {
  canonicalCloudflareSourceClock,
  currentCloudflareSourceClock,
} from "./source-clock";

type AccountKind = import("@/lib/auth/account-identity").AccountKind;

interface IdentityPayload {
  user: SessionUser;
  identity: {
    displayName: string;
    username: string;
    accountKind: AccountKind;
    birthDate: string | null;
  };
}

interface ProfilePayload {
  user: SessionUser;
  profile: Profile;
}

interface UsernamePayload {
  user: SessionUser;
  username: string;
}

interface ProgressPayload {
  user: SessionUser;
  snapshot: ProgressSnapshotMutation;
}

interface AvatarPutPayload {
  user: SessionUser;
  base64: string;
  kind: { ext: string; mime: string };
}

interface AvatarDeletePayload {
  user: SessionUser;
}

interface StripePayload {
  event: StripeReplicaEvent;
  eventPayload: unknown;
  authoritative: StripeSubscriptionReplica;
}

interface UsagePayload {
  event: CloudflareUsageEventReplica;
  user: SessionUser | null;
}

interface AiCostPayload {
  event: CloudflareAiCostEventReplica;
}

interface AiCostCoveragePayload {
  coverage: CloudflareAiCostCoverageReplica;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sessionUser(value: unknown): SessionUser | null {
  const row = record(value);
  if (!row || typeof row.id !== "string" || row.id.length < 16) return null;
  if (row.email !== null && typeof row.email !== "string") return null;
  if (row.createdAt !== undefined && row.createdAt !== null && typeof row.createdAt !== "string") {
    return null;
  }
  return {
    id: row.id,
    email: row.email as string | null,
    createdAt: row.createdAt as string | null | undefined,
  };
}

function sameSubject(task: CloudflareReplicaTask, user: SessionUser): boolean {
  return task.subjectUserId === user.id;
}

function binaryToBase64(body: ArrayBuffer): string {
  const bytes = new Uint8Array(body);
  let binary = "";
  const chunk = 16 * 1024;
  for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("Invalid avatar replica body");
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function profilePayload(task: CloudflareReplicaTask): ProfilePayload {
  const payload = record(task.payload);
  const user = sessionUser(payload?.user);
  const profile = record(payload?.profile);
  if (!user || !sameSubject(task, user) || !profile) {
    throw new Error("Invalid learner profile replica payload");
  }
  return { user, profile: profile as unknown as Profile };
}

function identityPayload(task: CloudflareReplicaTask): IdentityPayload {
  const payload = record(task.payload);
  const user = sessionUser(payload?.user);
  const identity = record(payload?.identity);
  if (
    !user || !sameSubject(task, user) || !identity
    || typeof identity.displayName !== "string"
    || typeof identity.username !== "string"
    || typeof identity.accountKind !== "string"
    || (identity.birthDate !== null && typeof identity.birthDate !== "string")
  ) {
    throw new Error("Invalid account identity replica payload");
  }
  return { user, identity: identity as unknown as IdentityPayload["identity"] };
}

function usernamePayload(task: CloudflareReplicaTask): UsernamePayload {
  const payload = record(task.payload);
  const user = sessionUser(payload?.user);
  if (!user || !sameSubject(task, user) || typeof payload?.username !== "string") {
    throw new Error("Invalid username replica payload");
  }
  return { user, username: payload.username };
}

function progressPayload(task: CloudflareReplicaTask): ProgressPayload {
  const payload = record(task.payload);
  const user = sessionUser(payload?.user);
  const snapshot = record(payload?.snapshot);
  if (!user || !sameSubject(task, user) || !snapshot || typeof snapshot.storeKey !== "string") {
    throw new Error("Invalid progress replica payload");
  }
  return { user, snapshot: snapshot as unknown as ProgressSnapshotMutation };
}

function avatarPutPayload(task: CloudflareReplicaTask): AvatarPutPayload {
  const payload = record(task.payload);
  const user = sessionUser(payload?.user);
  const kind = record(payload?.kind);
  if (
    !user || !sameSubject(task, user) || typeof payload?.base64 !== "string" || !kind
    || typeof kind.ext !== "string" || typeof kind.mime !== "string"
  ) {
    throw new Error("Invalid avatar replica payload");
  }
  return {
    user,
    base64: payload.base64,
    kind: { ext: kind.ext, mime: kind.mime },
  };
}

function avatarDeletePayload(task: CloudflareReplicaTask): AvatarDeletePayload {
  const payload = record(task.payload);
  const user = sessionUser(payload?.user);
  if (!user || !sameSubject(task, user)) throw new Error("Invalid avatar delete payload");
  return { user };
}

function stripePayload(task: CloudflareReplicaTask): StripePayload {
  const payload = record(task.payload);
  const event = record(payload?.event);
  const authoritative = record(payload?.authoritative);
  if (
    !event || !authoritative
    || typeof event.eventId !== "string" || typeof event.eventAt !== "string"
    || typeof authoritative.userId !== "string"
    || task.subjectUserId !== authoritative.userId
  ) {
    throw new Error("Invalid Stripe replica payload");
  }
  return {
    event: event as unknown as StripeReplicaEvent,
    eventPayload: payload?.eventPayload,
    authoritative: authoritative as unknown as StripeSubscriptionReplica,
  };
}

/** The only dispatcher allowed to execute persisted outbox payloads. */
export async function executeCloudflareReplicaTask(
  task: CloudflareReplicaTask,
  bindings: BandUpCloudflareBindings,
): Promise<boolean> {
  switch (task.operation) {
    case "learner_profile": {
      const payload = profilePayload(task);
      const profile = { ...payload.profile, updatedAt: task.sourceUpdatedAt };
      if (!await putCloudflareLearnerProfile(payload.user, profile, bindings)) return false;
      if (!profile.username) return true;
      const claimed = await claimCloudflareUsername(
        payload.user,
        profile.username,
        task.sourceUpdatedAt,
        bindings,
      );
      // A username may have changed in a newer authoritative commit while an
      // older full-profile repair was leased. That unique conflict is stale
      // success only when D1 already holds this account at the same/newer
      // source clock; another user's collision must stay retryable/dead.
      return claimed === "ok" || (
        claimed === "taken_username"
        && await cloudflareUsernameReplicaAtLeast(
          payload.user.id,
          task.sourceUpdatedAt,
          bindings,
        )
      );
    }
    case "account_identity": {
      const payload = identityPayload(task);
      const claimed = await setCloudflareAccountIdentity(
        payload.user,
        payload.identity,
        task.sourceUpdatedAt,
        bindings,
      );
      return claimed === "ok" || (
        claimed === "taken_username"
        && await cloudflareUsernameReplicaAtLeast(
          payload.user.id,
          task.sourceUpdatedAt,
          bindings,
        )
      );
    }
    case "username": {
      const payload = usernamePayload(task);
      const claimed = await claimCloudflareUsername(
        payload.user,
        payload.username,
        task.sourceUpdatedAt,
        bindings,
      );
      return claimed === "ok" || (
        claimed === "taken_username"
        && await cloudflareUsernameReplicaAtLeast(
          payload.user.id,
          task.sourceUpdatedAt,
          bindings,
        )
      );
    }
    case "progress_snapshot": {
      const payload = progressPayload(task);
      return replicateCloudflareProgressSnapshots(
        payload.user,
        [payload.snapshot],
        task.sourceUpdatedAt,
        bindings,
      );
    }
    case "avatar_put": {
      const payload = avatarPutPayload(task);
      const result = await putCloudflareAvatar(
        payload.user,
        base64ToArrayBuffer(payload.base64),
        payload.kind,
        bindings,
        (key) => enqueueCloudflareObjectCleanup(bindings, key, payload.user.id).then(() => undefined),
        task.sourceUpdatedAt,
      );
      return result.success || cloudflareAvatarReplicaAtLeast(
        payload.user.id,
        task.sourceUpdatedAt,
        bindings,
      );
    }
    case "avatar_delete": {
      const payload = avatarDeletePayload(task);
      const deleted = await deleteCloudflareAvatar(
        payload.user,
        bindings,
        (key) => enqueueCloudflareObjectCleanup(bindings, key, payload.user.id).then(() => undefined),
        task.sourceUpdatedAt,
      );
      return deleted || cloudflareAvatarReplicaAtLeast(
        payload.user.id,
        task.sourceUpdatedAt,
        bindings,
      );
    }
    case "stripe_billing": {
      const payload = stripePayload(task);
      return replicateAuthoritativeStripeState(
        payload.event,
        payload.eventPayload,
        payload.authoritative,
        bindings,
      );
    }
    case "usage_event": {
      const payload = record(task.payload);
      const event = record(payload?.event);
      const user = payload?.user === null ? null : sessionUser(payload?.user);
      if (!event || (payload?.user !== null && !user)) throw new Error("Invalid usage payload");
      if (task.subjectUserId !== (user?.id ?? null)) throw new Error("Usage subject mismatch");
      return mirrorCloudflareUsageEvent(
        event as unknown as CloudflareUsageEventReplica,
        user,
        bindings,
      );
    }
    case "ai_cost_event": {
      const payload = record(task.payload);
      const event = record(payload?.event);
      if (!event || task.subjectUserId !== null) throw new Error("Invalid AI cost payload");
      return mirrorCloudflareAiCostEvent(
        event as unknown as CloudflareAiCostEventReplica,
        bindings,
      );
    }
    case "ai_cost_coverage": {
      const payload = record(task.payload);
      const coverage = record(payload?.coverage);
      if (!coverage || task.subjectUserId !== null) throw new Error("Invalid coverage payload");
      return mirrorCloudflareAiCostCoverage(
        coverage as unknown as CloudflareAiCostCoverageReplica,
        bindings,
      );
    }
  }
}

async function mirrorDurably(
  task: CloudflareReplicaTask,
  direct: (bindings: BandUpCloudflareBindings) => Promise<boolean>,
): Promise<boolean> {
  let bindings: BandUpCloudflareBindings;
  try {
    bindings = await requireBandUpCloudflareBindings();
  } catch {
    return false;
  }

  let queued = false;
  try {
    queued = await enqueueCloudflareReplicaTask(task, bindings);
  } catch (error) {
    console.error(JSON.stringify({
      message: "cloudflare replica outbox enqueue failed",
      operation: task.operation,
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  let mirrored = false;
  try {
    mirrored = await direct(bindings);
  } catch (error) {
    console.error(JSON.stringify({
      message: "cloudflare direct replica failed",
      operation: task.operation,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  if (mirrored && queued) {
    await acknowledgeCloudflareReplicaTask(bindings, task).catch(() => false);
  }
  // Every dual write also advances a small page of earlier work. The bound is
  // deliberately low on request paths; retries never grow with backlog size.
  await drainCloudflareReplicaOutbox(executeCloudflareReplicaTask, bindings, {
    limit: 2,
    subjectUserId: task.subjectUserId ?? undefined,
  }).catch(() => undefined);
  return mirrored;
}

function sourceClock(value: string | null | undefined): string {
  return value && Number.isFinite(Date.parse(value))
    ? canonicalCloudflareSourceClock(value)
    : currentCloudflareSourceClock();
}

export async function replicateLearnerProfileDurably(
  user: SessionUser,
  profile: Profile,
): Promise<boolean> {
  const at = sourceClock(profile.updatedAt);
  const task: CloudflareReplicaTask<ProfilePayload> = {
    taskId: `profile:${user.id}`,
    operation: "learner_profile",
    subjectUserId: user.id,
    sourceUpdatedAt: at,
    payload: { user, profile: { ...profile, updatedAt: at } },
  };
  return mirrorDurably(task, (bindings) => executeCloudflareReplicaTask(task, bindings));
}

export async function replicateAccountIdentityDurably(
  user: SessionUser,
  identity: IdentityPayload["identity"],
  sourceUpdatedAt?: string | null,
): Promise<boolean> {
  const task: CloudflareReplicaTask<IdentityPayload> = {
    taskId: `identity:${user.id}`,
    operation: "account_identity",
    subjectUserId: user.id,
    sourceUpdatedAt: sourceClock(sourceUpdatedAt),
    payload: { user, identity },
  };
  return mirrorDurably(task, (bindings) => executeCloudflareReplicaTask(task, bindings));
}

export async function replicateUsernameDurably(
  user: SessionUser,
  username: string,
  sourceUpdatedAt?: string | null,
): Promise<boolean> {
  const task: CloudflareReplicaTask<UsernamePayload> = {
    taskId: `username:${user.id}`,
    operation: "username",
    subjectUserId: user.id,
    sourceUpdatedAt: sourceClock(sourceUpdatedAt),
    payload: { user, username },
  };
  return mirrorDurably(task, (bindings) => executeCloudflareReplicaTask(task, bindings));
}

export async function replicateProgressDurably(
  user: SessionUser,
  snapshots: ProgressSnapshotMutation[],
  sourceUpdatedAt: string,
): Promise<boolean> {
  const at = sourceClock(sourceUpdatedAt);
  const tasks = snapshots.map((snapshot): CloudflareReplicaTask<ProgressPayload> => ({
    taskId: `progress:${user.id}:${snapshot.storeKey}`,
    operation: "progress_snapshot",
    subjectUserId: user.id,
    sourceUpdatedAt: at,
    payload: { user, snapshot },
  }));
  let bindings: BandUpCloudflareBindings;
  try {
    bindings = await requireBandUpCloudflareBindings();
  } catch {
    return false;
  }
  const queued = new Set<string>();
  for (const task of tasks) {
    try {
      if (await enqueueCloudflareReplicaTask(task, bindings)) queued.add(task.taskId);
    } catch {
      // The authoritative Supabase batch is already committed. Continue with
      // the direct replica; a later source reconciliation can recreate work.
    }
  }
  let mirrored = false;
  try {
    mirrored = await replicateCloudflareProgressSnapshots(user, snapshots, at, bindings);
  } catch {
    mirrored = false;
  }
  if (mirrored) {
    for (const task of tasks) {
      if (queued.has(task.taskId)) {
        await acknowledgeCloudflareReplicaTask(bindings, task).catch(() => false);
      }
    }
  }
  await drainCloudflareReplicaOutbox(executeCloudflareReplicaTask, bindings, {
    limit: 2,
    subjectUserId: user.id,
  }).catch(() => undefined);
  return mirrored;
}

export async function replicateAvatarPutDurably(
  user: SessionUser,
  body: ArrayBuffer,
  kind: { ext: string; mime: string },
  sourceUpdatedAt?: string | null,
): Promise<boolean> {
  const task: CloudflareReplicaTask<AvatarPutPayload> = {
    taskId: `avatar:${user.id}`,
    operation: "avatar_put",
    subjectUserId: user.id,
    sourceUpdatedAt: sourceClock(sourceUpdatedAt),
    payload: { user, base64: binaryToBase64(body), kind },
  };
  return mirrorDurably(task, (bindings) => executeCloudflareReplicaTask(task, bindings));
}

export async function replicateAvatarDeleteDurably(
  user: SessionUser,
  sourceUpdatedAt?: string | null,
): Promise<boolean> {
  const task: CloudflareReplicaTask<AvatarDeletePayload> = {
    taskId: `avatar:${user.id}`,
    operation: "avatar_delete",
    subjectUserId: user.id,
    sourceUpdatedAt: sourceClock(sourceUpdatedAt),
    payload: { user },
  };
  return mirrorDurably(task, (bindings) => executeCloudflareReplicaTask(task, bindings));
}

export async function replicateStripeBillingDurably(
  event: StripeReplicaEvent,
  eventPayload: unknown,
  authoritative: StripeSubscriptionReplica,
): Promise<boolean> {
  const task: CloudflareReplicaTask<StripePayload> = {
    taskId: `stripe:${event.eventId}`,
    operation: "stripe_billing",
    subjectUserId: authoritative.userId,
    sourceUpdatedAt: sourceClock(authoritative.updatedAt),
    payload: { event, eventPayload, authoritative },
  };
  return mirrorDurably(task, (bindings) => executeCloudflareReplicaTask(task, bindings));
}

export async function replicateUsageEventDurably(
  event: CloudflareUsageEventReplica,
  user: SessionUser | null,
): Promise<boolean> {
  const task: CloudflareReplicaTask<UsagePayload> = {
    taskId: `usage:${event.id}`,
    operation: "usage_event",
    subjectUserId: event.userId,
    sourceUpdatedAt: sourceClock(event.createdAt),
    payload: { event, user },
  };
  return mirrorDurably(task, (bindings) => executeCloudflareReplicaTask(task, bindings));
}

export async function replicateAiCostEventDurably(
  event: CloudflareAiCostEventReplica,
): Promise<boolean> {
  const task: CloudflareReplicaTask<AiCostPayload> = {
    taskId: `ai-cost:${event.id}`,
    operation: "ai_cost_event",
    subjectUserId: null,
    sourceUpdatedAt: sourceClock(event.recordedAt),
    payload: { event },
  };
  return mirrorDurably(task, (bindings) => executeCloudflareReplicaTask(task, bindings));
}

export async function replicateAiCostCoverageDurably(
  coverage: CloudflareAiCostCoverageReplica,
): Promise<boolean> {
  const task: CloudflareReplicaTask<AiCostCoveragePayload> = {
    taskId: "ai-cost-coverage",
    operation: "ai_cost_coverage",
    subjectUserId: null,
    sourceUpdatedAt: sourceClock(coverage.recordedAt),
    payload: { coverage },
  };
  return mirrorDurably(task, (bindings) => executeCloudflareReplicaTask(task, bindings));
}
