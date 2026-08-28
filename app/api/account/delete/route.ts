import { after, NextResponse } from "next/server";
import { accountsEnabled } from "@/lib/auth/env";
import { supabaseConfigured, getProfile, deleteAccount } from "@/lib/auth/supabase";
import { getSessionUser, isNativeSessionRequest } from "@/lib/auth/session";
import { logInternal, safeJsonError, MESSAGES } from "@/lib/auth/errors";
import { withCors } from "@/lib/http/cors";
import { cloudflareDataMode, organizationDataMode } from "@/lib/cloudflare/bindings";
import {
  beginCloudflareAccountAuthDeletion,
  cancelCloudflareAccountDeletion,
  completeCloudflareAccountDeletion,
  confirmCloudflareAccountAuthDeleted,
  CloudflareAccountDeletionInProgressError,
  prepareCloudflareAccountDeletion,
} from "@/lib/cloudflare/account-deletion";

/*
  Closing an account.

  Apple's guideline 5.1.1(v) requires that an app offering account creation
  also offers account deletion from inside the app. It is a common rejection,
  and it is also the right behaviour: an account someone can create but not
  close is a one-way door.

  This deletes the account and everything the database holds against it. What
  it deliberately does not touch is the copy of their practice in their own
  browser — that is theirs, it never belonged to us, and clearing it is
  something they can do from their own browser settings whenever they choose.
  The UI says so before the button is pressed.
*/

export const dynamic = "force-dynamic";

function scheduleCloudflareCleanup(userId: string, operationId: string): void {
  // Next maps `after` to the deployment adapter's waitUntil primitive. The
  // durable tombstone and R2 manifest make this safe even if the platform
  // stops the callback: the owner recovery route can repeat the same cleanup.
  after(async () => {
    const cleanup = await completeCloudflareAccountDeletion(userId, operationId)
      .catch((error) => {
        logInternal("account/delete/cloudflare-background-cleanup", error);
        return null;
      });
    if (!cleanup?.complete) {
      logInternal(
        "account/delete/cloudflare-background-cleanup",
        new Error("cleanup remains pending"),
      );
    }
  });
}

async function handlePOST(req: Request) {
  const nativeSession = isNativeSessionRequest(req);
  if (!accountsEnabled() || (!nativeSession && !supabaseConfigured())) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const user = await getSessionUser(req);
  if (!user) return safeJsonError(MESSAGES.signInRequired, 401);

  /*
    A typed confirmation rather than a second button. Deletion cannot be
    undone, and the request is one fetch away from anything else on the page,
    so the intent has to be unambiguous at the point it arrives here rather
    than only in the interface.
  */
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  if ((body as { confirm?: unknown } | null)?.confirm !== "DELETE") {
    return safeJsonError("Type DELETE to confirm.", 400);
  }

  const profile = nativeSession ? null : await getProfile(user.id);
  const cloudflareDataActive = cloudflareDataMode() !== "supabase"
    || organizationDataMode() !== "supabase";
  if (nativeSession && !cloudflareDataActive) {
    // A native identity exists only in D1. Do not claim it was deleted until
    // its durable account cleanup can be performed there.
    logInternal("account/delete/native", new Error("native identity without Cloudflare data authority"));
    return safeJsonError(MESSAGES.accountUnavailable, 503);
  }
  let cloudflarePreparation: Awaited<ReturnType<typeof prepareCloudflareAccountDeletion>> | null = null;

  if (cloudflareDataActive) {
    try {
      // Build the complete D1/R2 manifest first. If this cannot be made
      // recoverable, the irreversible identity deletion must not start.
      cloudflarePreparation = await prepareCloudflareAccountDeletion(user);
    } catch (error) {
      if (error instanceof CloudflareAccountDeletionInProgressError) {
        return safeJsonError("Account deletion is already in progress. Please wait a moment.", 409);
      }
      logInternal("account/delete/cloudflare-prepare", error);
      return safeJsonError(MESSAGES.accountUnavailable, 503);
    }
  }

  // A still-valid request can resume a cleanup whose Auth deletion was
  // already confirmed. Ordinarily Supabase has invalidated the token by this
  // point, but keeping this branch makes the workflow idempotent under replay.
  if (
    cloudflarePreparation
    && (cloudflarePreparation.state === "auth_deleted"
      || cloudflarePreparation.state === "data_deleted"
      || cloudflarePreparation.state === "complete")
  ) {
    if (cloudflarePreparation.state === "complete") {
      return NextResponse.json({ deleted: true });
    }
    scheduleCloudflareCleanup(user.id, cloudflarePreparation.operationId);
    return NextResponse.json({ deleted: true, cleanupPending: true }, { status: 202 });
  }

  if (cloudflarePreparation?.state === "prepared") {
    try {
      cloudflarePreparation = await beginCloudflareAccountAuthDeletion(
        user.id,
        cloudflarePreparation.operationId,
      );
    } catch (error) {
      // The external Auth call has not started, so cancellation is still safe.
      await cancelCloudflareAccountDeletion(
        user.id,
        cloudflarePreparation.operationId,
      ).catch((cancelError) => logInternal("account/delete/cloudflare-cancel", cancelError));
      logInternal("account/delete/cloudflare-auth-start", error);
      return safeJsonError(MESSAGES.accountUnavailable, 503);
    }
  }

  if (!nativeSession && !(await deleteAccount(user.id, profile?.avatarPath ?? null))) {
    // The DELETE may have reached Supabase even when its response did not
    // reach us. Keep the durable freeze and manifest for owner reconciliation;
    // cancelling here could resurrect data for an identity that is already gone.
    logInternal("account/delete", new Error("account deletion failed"));
    return safeJsonError("Account deletion is pending. Please try again shortly.", 503);
  }

  if (cloudflarePreparation) {
    // Persist the confirmed irreversible step before replying, then let the
    // potentially large D1/R2 purge continue after the response. The client
    // can sign out immediately and the durable job remains recoverable.
    await confirmCloudflareAccountAuthDeleted(
      user.id,
      cloudflarePreparation.operationId,
    ).catch((error) => logInternal("account/delete/cloudflare-confirm-auth", error));
    scheduleCloudflareCleanup(user.id, cloudflarePreparation.operationId);
    return NextResponse.json({ deleted: true, cleanupPending: true }, { status: 202 });
  }

  return NextResponse.json({ deleted: true });
}

/*
  CORS lives on the route now rather than in proxy.ts, which cannot run on
  Cloudflare. Same behaviour, different place — see lib/http/cors.ts.
*/
export { OPTIONS } from "@/lib/http/cors";
export const POST = withCors(handlePOST);
