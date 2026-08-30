import { NextResponse } from "next/server";
import { accountsEnabled, isAdminEmail } from "@/lib/auth/env";
import { logInternal, safeJsonError } from "@/lib/auth/errors";
import { getSessionUser } from "@/lib/auth/session";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { nativeIdentityReadinessReport } from "@/lib/cloudflare/native-identity-audit";
import { withCors } from "@/lib/http/cors";

export const dynamic = "force-dynamic";

/**
 * Aggregate-only proof before a Google-subject backfill. It is deliberately
 * separate from the application-data readiness endpoint: identity data has a
 * different source of truth and must not be mistaken for row-parity evidence.
 */
async function handleGET(req: Request) {
  if (!accountsEnabled() || !supabaseConfigured()) return safeJsonError("Not found.", 404);
  const actor = await getSessionUser(req).catch(() => null);
  if (!actor || !isAdminEmail(actor.email)) return safeJsonError("Not found.", 404);
  try {
    const report = await nativeIdentityReadinessReport();
    return NextResponse.json(report, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logInternal("admin/cloudflare/identity-readiness", error);
    return safeJsonError("Cloudflare identity readiness is unavailable right now.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
