import { NextResponse } from "next/server";
import { accountsEnabled, isAdminEmail } from "@/lib/auth/env";
import { logInternal, safeJsonError } from "@/lib/auth/errors";
import { getSessionUser } from "@/lib/auth/session";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { cloudflareMigrationReadinessReport } from "@/lib/cloudflare/migration-readiness";
import { withCors } from "@/lib/http/cors";

export const dynamic = "force-dynamic";

async function handleGET(req: Request) {
  if (!accountsEnabled() || !supabaseConfigured()) {
    return safeJsonError("Not found.", 404);
  }
  const actor = await getSessionUser(req).catch(() => null);
  if (!actor || !isAdminEmail(actor.email)) return safeJsonError("Not found.", 404);

  try {
    return NextResponse.json(await cloudflareMigrationReadinessReport(), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    logInternal("admin/cloudflare/readiness", error);
    return safeJsonError("Cloudflare migration readiness is unavailable right now.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
