import { after, NextResponse } from "next/server";
import { accountsEnabled } from "@/lib/auth/env";
import { logInternal, MESSAGES, safeJsonError } from "@/lib/auth/errors";
import { getSessionUser } from "@/lib/auth/session";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { withCors } from "@/lib/http/cors";
import { isOrganizationAction } from "@/lib/organizations/actions";
import { OrganizationCommandError } from "@/lib/cloudflare/organization-commands";
import {
  isOrganizationPreviewRequest,
  organizationPreviewPayloadAllowed,
  organizationPreviewUser,
} from "@/lib/organizations/preview-auth";
import { organizationCommand, organizationPortal } from "@/lib/organizations/server";
import { organizationDataMode } from "@/lib/cloudflare/bindings";
import { drainCloudflareOrganizationAttemptOutbox } from "@/lib/cloudflare/organization-attempt-outbox";
import { reconcileOrganizationAttemptObjects } from "@/lib/cloudflare/organization-attempt-objects";

export const dynamic = "force-dynamic";

const MAX_COMMAND_BYTES = 64 * 1024;
const IDEMPOTENCY = /^[A-Za-z0-9._:-]{12,120}$/;

async function requireUser(req: Request) {
  const previewRequest = isOrganizationPreviewRequest(req);
  const previewUser = organizationPreviewUser(req);
  if (previewUser) return { user: previewUser };
  // Fail closed on the dedicated preview host. In particular, a malformed
  // role header must never fall through to a real Supabase session.
  if (previewRequest) return { error: "preview_role" as const };
  if (!accountsEnabled() || !supabaseConfigured()) return { error: "off" as const };
  const user = await getSessionUser(req).catch(() => null);
  return user ? { user } : { error: "anon" as const };
}

async function handleGET(req: Request) {
  const auth = await requireUser(req);
  if (auth.error === "preview_role") {
    return safeJsonError("Invalid preview role.", 400);
  }
  if (auth.error === "off") return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (auth.error === "anon") return safeJsonError(MESSAGES.signInRequired, 401);

  try {
    const selectedOrganizationId = new URL(req.url).searchParams.get("organization");
    if (selectedOrganizationId && !/^[0-9a-f-]{36}$/i.test(selectedOrganizationId)) {
      return safeJsonError("Invalid organisation.", 400);
    }
    const portal = await organizationPortal(auth.user, selectedOrganizationId);
    if (organizationDataMode() !== "supabase") {
      after(async () => {
        await drainCloudflareOrganizationAttemptOutbox({ limit: 4 }).catch(() => undefined);
        await reconcileOrganizationAttemptObjects(undefined, { limit: 8 }).catch(() => undefined);
      });
    }
    return NextResponse.json(portal, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    logInternal("organization GET", error);
    return safeJsonError("Your organisation could not be loaded just now. Nothing was changed.", 503);
  }
}

async function handlePOST(req: Request) {
  const previewRequest = isOrganizationPreviewRequest(req);
  const auth = await requireUser(req);
  // Every request on the shared preview host is read-only, including one with
  // a malformed role header. Do not reveal or consult a real account session.
  if (auth.error === "preview_role") {
    return safeJsonError(
      "This shared preview is read-only. No account or organisation was changed.",
      403,
    );
  }
  if (auth.error === "off") return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (auth.error === "anon") return safeJsonError(MESSAGES.signInRequired, 401);

  const raw = await req.text();
  if (raw.length > MAX_COMMAND_BYTES) return safeJsonError("That request is too large.", 413);

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return safeJsonError("Invalid request.", 400);
  }
  const candidate = body as {
    action?: unknown;
    payload?: unknown;
    idempotencyKey?: unknown;
  };
  if (!isOrganizationAction(candidate.action)) return safeJsonError("Unknown organisation action.", 400);
  if (!candidate.payload || typeof candidate.payload !== "object" || Array.isArray(candidate.payload)) {
    return safeJsonError("Invalid organisation action.", 400);
  }
  if (typeof candidate.idempotencyKey !== "string" || !IDEMPOTENCY.test(candidate.idempotencyKey)) {
    return safeJsonError("This action needs a valid request identifier.", 400);
  }
  if (
    previewRequest
    && !organizationPreviewPayloadAllowed(
      candidate.action,
      candidate.payload as Record<string, unknown>,
    )
  ) {
    return safeJsonError("Use a preview email in this shared demo.", 400);
  }
  if (previewRequest) {
    return safeJsonError(
      "This shared preview is read-only. No account or organisation was changed.",
      403,
    );
  }

  try {
    const result = await organizationCommand(
      auth.user,
      candidate.action,
      candidate.payload as Record<string, unknown>,
      candidate.idempotencyKey,
    );
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    if (error instanceof OrganizationCommandError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        {
          status: error.status,
          headers: { "Cache-Control": "private, no-store, max-age=0" },
        },
      );
    }
    logInternal(`organization POST:${candidate.action}`, error);
    return safeJsonError(
      "That action was not completed. No success was recorded—reload and try again.",
      503,
    );
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
export const POST = withCors(handlePOST);
