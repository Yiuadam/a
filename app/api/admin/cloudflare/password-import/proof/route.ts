import { NextResponse } from "next/server";
import { accountsEnabled, isAdminEmail } from "@/lib/auth/env";
import { safeJsonError } from "@/lib/auth/errors";
import { getSessionUser } from "@/lib/auth/session";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { certifyNativePasswordMigration } from "@/lib/cloudflare/native-password-migration-audit";
import { withCors } from "@/lib/http/cors";

export const dynamic = "force-dynamic";

async function owner(request: Request) {
  /* A pre-cutover legacy session can authorise this narrow migration receipt,
     but it never receives or displays password material. */
  if (!accountsEnabled() || !supabaseConfigured()) return null;
  const actor = await getSessionUser(request).catch(() => null);
  return actor && isAdminEmail(actor.email) ? actor : null;
}

/**
 * Records a single aggregate certificate after the confidential local importer
 * has sent every verifier. It accepts only the count and SHA-256 commitment;
 * identifiers, emails and bcrypt values never cross this route.
 */
async function handlePOST(request: Request) {
  if (!(await owner(request))) return safeJsonError("Not found.", 404);
  let body: { confirm?: unknown; sourceRows?: unknown; sourceManifestSha256?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return safeJsonError("Send the confirmed aggregate password-import receipt.", 400);
  }
  if (body.confirm !== true) {
    return safeJsonError("Set confirm: true to record the aggregate password-import receipt. This does not enable native sign-in.", 400);
  }

  const evidence = await certifyNativePasswordMigration(
    body.sourceRows,
    body.sourceManifestSha256,
  );
  if (evidence.status === "missing") {
    return safeJsonError("D1 password-proof migration 0021 has not been applied. Nothing was certified.", 409);
  }
  if (evidence.status === "mismatch") {
    return safeJsonError("The imported D1 set does not yet match the complete password export. Nothing was certified.", 409);
  }
  if (evidence.status !== "verified" || evidence.sourceRows === null || evidence.importedRows === null || !evidence.verifiedAt) {
    return safeJsonError("The aggregate password-import receipt could not be verified. Nothing was enabled.", 503);
  }
  return NextResponse.json(
    {
      verified: true,
      sourceRows: evidence.sourceRows,
      importedRows: evidence.importedRows,
      verifiedAt: evidence.verifiedAt,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export { OPTIONS } from "@/lib/http/cors";
export const POST = withCors(handlePOST);
