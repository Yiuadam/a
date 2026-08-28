import { NextResponse } from "next/server";
import { accountsEnabled, isAdminEmail } from "@/lib/auth/env";
import { accountRuntimeEnabled } from "@/lib/auth/runtime";
import { getSessionUser } from "@/lib/auth/session";
import {
  supabaseAuthUserState,
} from "@/lib/auth/supabase";
import { logInternal, safeJsonError } from "@/lib/auth/errors";
import { withCors } from "@/lib/http/cors";
import {
  beginCloudflareAccountAuthDeletion,
  cancelCloudflareAccountDeletion,
  cloudflareAccountDeletionJob,
  cloudflareNativeAccountState,
  completeCloudflareAccountDeletion,
  pendingCloudflareAccountDeletionJobs,
  reopenCloudflareNativeAccountDeletion,
} from "@/lib/cloudflare/account-deletion";

export const dynamic = "force-dynamic";

const USER_ID = /^[A-Za-z0-9_-]{16,80}$/;
const notFound = () => NextResponse.json({ error: "Not found." }, { status: 404 });

async function requireOwner(req: Request) {
  if (!accountsEnabled() || !accountRuntimeEnabled()) return null;
  const user = await getSessionUser(req).catch(() => null);
  return user && isAdminEmail(user.email) ? user : null;
}

/** Owner-only operational view; it intentionally contains no profile data. */
async function handleGET(req: Request) {
  if (!(await requireOwner(req))) return notFound();
  try {
    return NextResponse.json({ jobs: await pendingCloudflareAccountDeletionJobs() });
  } catch (error) {
    logInternal("admin/account-deletions/list", error);
    return safeJsonError("Account deletion recovery is unavailable.", 503);
  }
}

/**
 * Reconcile one ambiguous deletion. The tombstone chooses its identity
 * authority; personal D1/R2 data is never purged merely because a DELETE was
 * attempted.
 */
async function handlePOST(req: Request) {
  if (!(await requireOwner(req))) return notFound();
  let body: { userId?: unknown };
  try {
    body = await req.json();
  } catch {
    return safeJsonError("Invalid request body.", 400);
  }
  if (typeof body.userId !== "string" || !USER_ID.test(body.userId)) {
    return safeJsonError("Send a valid userId.", 400);
  }

  try {
    let job = await cloudflareAccountDeletionJob(body.userId);
    if (!job) return notFound();
    if (job.state === "complete") return NextResponse.json({ job, authState: "deleted" });

    if (job.state === "prepared" || job.state === "auth_delete_started") {
      if (job.authAuthority === "cloudflare") {
        const authState = await cloudflareNativeAccountState(job.userId);
        if (authState === "unknown") {
          return safeJsonError("Cloudflare identity could not be verified. Nothing was changed.", 503);
        }
        if (authState === "exists") {
          if (job.state === "prepared") {
            await cancelCloudflareAccountDeletion(job.userId, job.operationId);
            return NextResponse.json({ cancelled: true, authState });
          }
          const reopened = await reopenCloudflareNativeAccountDeletion(
            job.userId,
            job.operationId,
          );
          if (!reopened) return safeJsonError("Cloudflare identity recovery is unavailable.", 503);
          return NextResponse.json(
            { reopened: true, authState, message: "The native identity still exists; ask the user to retry deletion." },
            { status: 409 },
          );
        }
        if (job.state === "prepared") {
          await beginCloudflareAccountAuthDeletion(job.userId, job.operationId);
          job = (await cloudflareAccountDeletionJob(job.userId)) ?? job;
        }
      } else {
        const authState = await supabaseAuthUserState(job.userId);
        if (authState === "unknown") {
          return safeJsonError("Supabase Auth could not be verified. Nothing was changed.", 503);
        }
        if (authState === "exists") {
          if (job.state === "prepared") {
            await cancelCloudflareAccountDeletion(job.userId, job.operationId);
            return NextResponse.json({ cancelled: true, authState });
          }
          return NextResponse.json(
            { error: "The Supabase Auth user still exists. Ask the user to retry deletion.", authState },
            { status: 409 },
          );
        }
        if (job.state === "prepared") {
          await beginCloudflareAccountAuthDeletion(job.userId, job.operationId);
          job = (await cloudflareAccountDeletionJob(job.userId)) ?? job;
        }
      }
    }

    const result = await completeCloudflareAccountDeletion(job.userId, job.operationId);
    const refreshed = await cloudflareAccountDeletionJob(job.userId);
    return NextResponse.json(
      { job: refreshed, cleanupPending: !result.complete },
      { status: result.complete ? 200 : 202 },
    );
  } catch (error) {
    logInternal("admin/account-deletions/reconcile", error);
    return safeJsonError("Account deletion recovery is unavailable.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
export const POST = withCors(handlePOST);
