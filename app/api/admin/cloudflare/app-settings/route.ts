import { NextResponse } from "next/server";
import { accountsEnabled, isAdminEmail } from "@/lib/auth/env";
import { logInternal, safeJsonError } from "@/lib/auth/errors";
import { getSessionUser } from "@/lib/auth/session";
import { supabaseConfigured } from "@/lib/auth/supabase";
import {
  appSettingsParityReport,
  reconcileAppSettingsReplica,
} from "@/lib/cloudflare/app-settings-parity";
import { cloudflareDataMode } from "@/lib/cloudflare/bindings";
import { withCors } from "@/lib/http/cors";

export const dynamic = "force-dynamic";

async function owner(req: Request) {
  if (!accountsEnabled() || !supabaseConfigured()) return null;
  const actor = await getSessionUser(req).catch(() => null);
  return actor && isAdminEmail(actor.email) ? actor : null;
}

const headers = { "Cache-Control": "private, no-store" };

async function handleGET(req: Request) {
  if (!(await owner(req))) return safeJsonError("Not found.", 404);
  try {
    return NextResponse.json(await appSettingsParityReport(), { headers });
  } catch (error) {
    logInternal("admin/cloudflare/app-settings:report", error);
    return safeJsonError("App-settings parity is unavailable right now.", 503);
  }
}

async function handlePOST(req: Request) {
  if (!(await owner(req))) return safeJsonError("Not found.", 404);
  if (cloudflareDataMode() !== "dual") {
    return safeJsonError("Reconciliation is available only while dual mode is active.", 409);
  }
  try {
    return NextResponse.json(await reconcileAppSettingsReplica(), { headers });
  } catch (error) {
    logInternal("admin/cloudflare/app-settings:reconcile", error);
    return safeJsonError("The app-settings replica could not be reconciled.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
export const POST = withCors(handlePOST);
