import { NextResponse } from "next/server";
import { accountsEnabled, isAdminEmail } from "@/lib/auth/env";
import { getSessionUser } from "@/lib/auth/session";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { logInternal, safeJsonError } from "@/lib/auth/errors";
import { withCors } from "@/lib/http/cors";
import { requireBandUpCloudflareBindings } from "@/lib/cloudflare/bindings";
import {
  cloudflareReplicaOutboxStatus,
  drainCloudflareReplicaOutbox,
  requeueDeadCloudflareReplicaTasks,
} from "@/lib/cloudflare/replica-outbox";
import { executeCloudflareReplicaTask } from "@/lib/cloudflare/replica-replay";

export const dynamic = "force-dynamic";

async function owner(req: Request) {
  if (!accountsEnabled() || !supabaseConfigured()) return null;
  const actor = await getSessionUser(req).catch(() => null);
  return actor && isAdminEmail(actor.email) ? actor : null;
}

const notFound = () => safeJsonError("Not found.", 404);

/** No payload or learner details are returned: this is operational evidence. */
async function handleGET(req: Request) {
  if (!(await owner(req))) return notFound();
  try {
    const bindings = await requireBandUpCloudflareBindings();
    return NextResponse.json({ status: await cloudflareReplicaOutboxStatus(bindings) });
  } catch (error) {
    logInternal("admin/cloudflare/replica-outbox/status", error);
    return safeJsonError("Cloudflare replica status is unavailable.", 503);
  }
}

/**
 * Drain one bounded page. Dead letters move only on the owner's explicit
 * `retryDead` action; ordinary traffic cannot create an unbounded retry loop.
 */
async function handlePOST(req: Request) {
  if (!(await owner(req))) return notFound();
  let input: { limit?: unknown; retryDead?: unknown } = {};
  try {
    input = await req.json();
  } catch {
    // An empty body uses the safe defaults.
  }
  const requested = typeof input.limit === "number" ? Math.trunc(input.limit) : 4;
  const limit = Math.max(1, Math.min(8, requested));

  try {
    const bindings = await requireBandUpCloudflareBindings();
    const requeued = input.retryDead === true
      ? await requeueDeadCloudflareReplicaTasks(bindings, limit)
      : { tasks: 0, objects: 0 };
    const drained = await drainCloudflareReplicaOutbox(
      executeCloudflareReplicaTask,
      bindings,
      { limit },
    );
    return NextResponse.json({
      requeued,
      drained,
      status: await cloudflareReplicaOutboxStatus(bindings),
    });
  } catch (error) {
    logInternal("admin/cloudflare/replica-outbox/drain", error);
    return safeJsonError("Cloudflare replica reconciliation is unavailable.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
export const POST = withCors(handlePOST);
