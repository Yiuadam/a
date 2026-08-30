import { NextResponse } from "next/server";
import { accountsEnabled, isAdminEmail } from "@/lib/auth/env";
import { logInternal, safeJsonError } from "@/lib/auth/errors";
import { getSessionUser } from "@/lib/auth/session";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { backfillNativeGoogleIdentities } from "@/lib/cloudflare/native-identity-backfill";
import { nativeIdentityReadinessReport } from "@/lib/cloudflare/native-identity-audit";
import { withCors } from "@/lib/http/cors";

export const dynamic = "force-dynamic";

async function owner(request: Request) {
  if (!accountsEnabled() || !supabaseConfigured()) return null;
  const actor = await getSessionUser(request).catch(() => null);
  return actor && isAdminEmail(actor.email) ? actor : null;
}

/**
 * Owner-only, explicit one-time migration action. It performs no account
 * matching by email and refuses unless the separate aggregate audit has
 * already proved that every source Google identity has a stable D1 user id.
 */
async function handlePOST(request: Request) {
  if (!(await owner(request))) return safeJsonError("Not found.", 404);
  let body: { confirm?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return safeJsonError("Send { confirm: true } to copy the audited Google subject mappings.", 400);
  }
  if (body.confirm !== true) {
    return safeJsonError("Set confirm: true to copy the audited Google subject mappings. This does not enable native sign-in.", 400);
  }

  try {
    const readiness = await nativeIdentityReadinessReport();
    if (!readiness.readyForBackfill) {
      return safeJsonError("Google identity mappings are not ready to copy yet. Review the Cloudflare identity readiness card first.", 409);
    }
    const result = await backfillNativeGoogleIdentities();
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logInternal("admin/cloudflare/identity-backfill", error);
    return safeJsonError("Google identity mappings could not be copied. Nothing was enabled.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const POST = withCors(handlePOST);
