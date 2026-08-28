import { NextResponse } from "next/server";
import { accountsEnabled, isAdminEmail } from "@/lib/auth/env";
import { safeJsonError } from "@/lib/auth/errors";
import { getSessionUser } from "@/lib/auth/session";
import { supabaseConfigured } from "@/lib/auth/supabase";
import {
  importNativePasswordCredential,
  parseImportedPasswordCredential,
} from "@/lib/cloudflare/native-password-import";
import { withCors } from "@/lib/http/cors";

export const dynamic = "force-dynamic";

async function owner(request: Request) {
  /* The current Supabase session is accepted only to authorise this one-time,
     pre-cutover migration action. The imported verifier is written to D1; the
     runtime sign-in path never consults Supabase after native cutover. */
  if (!accountsEnabled() || !supabaseConfigured()) return null;
  const actor = await getSessionUser(request).catch(() => null);
  return actor && isAdminEmail(actor.email) ? actor : null;
}

/**
 * Imports exactly one encrypted verifier per request. This keeps the sensitive
 * payload bounded and makes each D1 batch independently atomic and retryable.
 * The response deliberately contains counts/status only, never an email, user
 * id or verifier.
 */
async function handlePOST(request: Request) {
  if (!(await owner(request))) return safeJsonError("Not found.", 404);
  let body: { confirm?: unknown; credential?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return safeJsonError("Send one confirmed password credential import record.", 400);
  }
  if (body.confirm !== true) {
    return safeJsonError("Set confirm: true to import one encrypted password verifier. This does not enable native sign-in.", 400);
  }
  const credential = parseImportedPasswordCredential(body.credential);
  if (!credential) return safeJsonError("The password credential import record is invalid.", 400);

  try {
    const outcome = await importNativePasswordCredential(credential);
    if (outcome === "mismatch") {
      return safeJsonError("The password credential does not match a live Cloudflare account. Nothing was imported.", 409);
    }
    return NextResponse.json(
      { processed: 1, stored: outcome === "stored" ? 1 : 0, alreadyNewer: outcome === "already_newer" ? 1 : 0 },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    /* Do not even log the provider error here: a low-level binding error is
       allowed to contain a bound value, which in this route is authentication
       material. The owner gets a fixed failure and can safely retry. */
    return safeJsonError("The password credential could not be imported. Nothing was enabled.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const POST = withCors(handlePOST);
