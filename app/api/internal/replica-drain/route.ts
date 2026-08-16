import { NextResponse } from "next/server";
import { logInternal, safeJsonError } from "@/lib/auth/errors";
import { requireBandUpCloudflareBindings } from "@/lib/cloudflare/bindings";
import { runScheduledReplicaDrain } from "@/lib/cloudflare/scheduled-replica-drain";
import {
  consumeScheduledDrainTicket,
  SCHEDULED_DRAIN_HEADER,
} from "@/lib/cloudflare/scheduled-drain-ticket";
import { withCors } from "@/lib/http/cors";

/*
  The scheduled drain's way into the app, and nobody else's.

  ---------------------------------------------------------------------------
  Why the cron handler calls a route at all

  The `scheduled` handler lives in cloudflare/worker-entry.mjs, outside the
  Next build: OpenNext generates a worker whose only export is `fetch`, so a
  cron handler has to be added around it rather than inside it. That handler
  could talk to D1 and R2 directly — but then the replay logic would have to be
  reachable from a hand-written Worker entry, with its own copy of the module
  aliasing, its own bundling and no Next request context, and the executor it
  needs (`executeCloudflareReplicaTask`) is ordinary app code that expects one.

  So the handler does the one thing that gets it all of that for free: it calls
  the app, in process, with a request. Everything downstream is the same code
  path an admin drain already takes.

  ---------------------------------------------------------------------------
  Why a one-shot in-memory ticket rather than a secret

  This route must be callable by the cron handler and by nothing else on the
  internet. A shared secret would work and would cost a new Worker variable —
  one more thing to set by hand, to leave unset by accident, and to have
  deleted by the `keep_vars` trap described in wrangler.jsonc. A route whose
  authentication is a variable somebody forgot is a route that is either open
  or broken, and neither would announce itself.

  The ticket avoids the question. The cron handler mints a random one, holds it
  in the isolate for the length of its own call, and destroys it afterwards; a
  request carrying it must have come from the handler, because nothing else has
  ever seen it. An outside caller has nothing to guess, and between runs there
  is no valid value at all.

  Anything unauthenticated gets the same 404 the admin routes give, so this
  path is not even distinguishable from a route that does not exist. Admins who
  want to drain by hand already have /api/admin/cloudflare/replica-outbox.
*/

export const dynamic = "force-dynamic";

const notFound = () => safeJsonError("Not found.", 404);

async function handlePOST(req: Request) {
  if (!consumeScheduledDrainTicket(req.headers.get(SCHEDULED_DRAIN_HEADER))) return notFound();
  try {
    const bindings = await requireBandUpCloudflareBindings();
    const run = await runScheduledReplicaDrain(bindings);
    /*
      Counts, never contents. This body is read by the cron handler and written
      to the Worker log, so it holds what an operator needs to see a run work
      and nothing that identifies a learner.
    */
    return NextResponse.json({
      ranAt: run.ranAt,
      outbox: run.outbox,
      cleanup: run.cleanup,
      pending: run.status.pending,
      dead: run.status.dead,
      cleanupPending: run.status.cleanupPending,
      cleanupDead: run.status.cleanupDead,
      blockedByAccountDeletion: run.status.blockedByAccountDeletion,
    });
  } catch (error) {
    // Threat 7: the provider's own words never leave the Worker.
    logInternal("internal/replica-drain", error);
    return safeJsonError("Scheduled replica drain is unavailable.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const POST = withCors(handlePOST);
