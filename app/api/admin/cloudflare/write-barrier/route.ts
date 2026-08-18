import { NextResponse } from "next/server";
import { accountsEnabled, isAdminEmail } from "@/lib/auth/env";
import { getSessionUser } from "@/lib/auth/session";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { logInternal, safeJsonError } from "@/lib/auth/errors";
import { withCors } from "@/lib/http/cors";
import {
  cloudflareDataMode,
  organizationDataMode,
  requireBandUpCloudflareBindings,
} from "@/lib/cloudflare/bindings";
import {
  armCutoverWriteBarrier,
  cutoverWriteBarrierReadiness,
  type CutoverWriteBarrierDomain,
} from "@/lib/cloudflare/write-barrier";

/*
  The one deliberate owner action that arms a cutover write barrier.

  Nothing else in this codebase calls armCutoverWriteBarrier — not a drain,
  not the readiness report, not a scheduled job. That is the whole point: the
  owner has accepted a no-return point instead of a reverse mirror, but only
  ever as an explicit act. See lib/cloudflare/write-barrier.ts for what arming
  actually does and why it cannot be undone once it succeeds.
*/

export const dynamic = "force-dynamic";

async function owner(req: Request) {
  if (!accountsEnabled() || !supabaseConfigured()) return null;
  const actor = await getSessionUser(req).catch(() => null);
  return actor && isAdminEmail(actor.email) ? actor : null;
}

const notFound = () => safeJsonError("Not found.", 404);

function isDomain(value: unknown): value is CutoverWriteBarrierDomain {
  return value === "learner" || value === "organization";
}

/** Current state for both domains — never a bare "unsupported" string. */
async function handleGET(req: Request) {
  if (!(await owner(req))) return notFound();
  try {
    const bindings = await requireBandUpCloudflareBindings();
    const [learner, organization] = await Promise.all([
      cutoverWriteBarrierReadiness(bindings, "learner"),
      cutoverWriteBarrierReadiness(bindings, "organization"),
    ]);
    return NextResponse.json({
      barriers: [learner, organization],
      modes: { learner: cloudflareDataMode(), organization: organizationDataMode() },
    });
  } catch (error) {
    logInternal("admin/cloudflare/write-barrier/status", error);
    return safeJsonError("Cutover write barrier status is unavailable.", 503);
  }
}

/**
 * Arms a barrier. Requires `{ domain, confirm: true }` — the confirm flag
 * exists so this can never be triggered by a bookmarked GET or an automated
 * retry of a POST that timed out before its response arrived; a caller has
 * to state the intent every single time.
 */
async function handlePOST(req: Request) {
  const actor = await owner(req);
  if (!actor) return notFound();

  let body: { domain?: unknown; confirm?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return safeJsonError("Send { domain: \"learner\", confirm: true }.", 400);
  }
  const domain = body.domain ?? "learner";
  if (!isDomain(domain)) {
    return safeJsonError("domain must be \"learner\" or the organisation cutover domain from lib/cloudflare/write-barrier.ts.", 400);
  }
  if (body.confirm !== true) {
    return safeJsonError(
      "Set confirm: true to arm this barrier. It is one-way and cannot be undone from here.",
      400,
    );
  }

  const fromAuthority = domain === "organization" ? organizationDataMode() : cloudflareDataMode();
  if (fromAuthority === "cloudflare") {
    // The env-var flip this barrier exists to protect has already happened.
    // Arming now cannot record a meaningful "from" authority — the CHECK
    // constraint in 0015 would refuse the row for exactly this reason — so
    // this is caught here for a clear message rather than a database error.
    return safeJsonError(
      `The ${domain} switch already reads "cloudflare". This barrier exists to close the gap before that deploy, not after it — there is nothing left to arm.`,
      409,
    );
  }

  const recordedBy = actor.email ?? actor.id;
  try {
    const bindings = await requireBandUpCloudflareBindings();
    const result = await armCutoverWriteBarrier(domain, fromAuthority, recordedBy, bindings);
    if (result.ok) {
      return NextResponse.json({ armed: true, barrier: result.record });
    }
    if (result.reason === "already_armed") {
      return NextResponse.json({ armed: true, barrier: result.record, alreadyArmed: true });
    }
    if (result.reason === "outbox_not_drained") {
      return safeJsonError(
        `The replica outbox is not fully drained yet: ${result.detail}. Drain it from `
          + "the replica-outbox admin route, then try again.",
        409,
      );
    }
    return safeJsonError("Cloudflare data bindings are unavailable.", 503);
  } catch (error) {
    logInternal("admin/cloudflare/write-barrier/arm", error);
    return safeJsonError("Arming the write barrier failed. Nothing was changed.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
export const POST = withCors(handlePOST);
