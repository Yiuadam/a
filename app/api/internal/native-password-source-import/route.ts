import { NextResponse } from "next/server";
import { safeJsonError } from "@/lib/auth/errors";
import { assertServerOnly } from "@/lib/auth/server-only";
import { certifyNativePasswordMigration } from "@/lib/cloudflare/native-password-migration-audit";
import { nativeIdentityReadinessReport } from "@/lib/cloudflare/native-identity-audit";
import { backfillNativeGoogleIdentities } from "@/lib/cloudflare/native-identity-backfill";
import {
  importNativePasswordCredentialBatch,
  parseImportedPasswordCredential,
} from "@/lib/cloudflare/native-password-import";
import { passwordProofManifest } from "@/lib/cloudflare/native-password-proof";
import { cloudflareMigrationReadinessReport } from "@/lib/cloudflare/migration-readiness";
import { stripeCutoverReadinessReport } from "@/lib/cloudflare/stripe-cutover-readiness";
import { withCors } from "@/lib/http/cors";

export const dynamic = "force-dynamic";

const MODULE = "app/api/internal/native-password-source-import/route.ts";

function hasCapability(request: Request): boolean {
  assertServerOnly(MODULE);
  const expected = process.env.NATIVE_PASSWORD_IMPORT_CAPABILITY ?? "";
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (expected.length < 32 || supplied.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * A deliberately short-lived migration endpoint. It is unreachable unless a
 * fresh deployment secret is present, accepts only reviewed migration actions,
 * and returns aggregate receipts only. Delete the secret immediately after the
 * verified import; without it the route is indistinguishable from not found.
 */
async function handlePOST(request: Request) {
  if (!hasCapability(request)) return safeJsonError("Not found.", 404);
  let body: { confirm?: unknown; operation?: unknown; credentials?: unknown };
  try {
    body = await request.json();
  } catch {
    return safeJsonError("Send a confirmed migration action.", 400);
  }
  if (body.confirm !== true) {
    return safeJsonError("Set confirm: true to run the migration action.", 400);
  }
  const operation = body.operation ?? "password_import";
  try {
    if (operation === "identity_audit") {
      const identity = await nativeIdentityReadinessReport();
      return NextResponse.json({ identity }, { headers: { "Cache-Control": "no-store" } });
    }
    if (operation === "identity_backfill") {
      const before = await nativeIdentityReadinessReport();
      if (!before.readyForBackfill) {
        return safeJsonError("Google identity mappings are not ready to copy. Nothing was changed.", 409);
      }
      const copied = await backfillNativeGoogleIdentities();
      const identity = await nativeIdentityReadinessReport();
      return NextResponse.json({ copied, identity }, { headers: { "Cache-Control": "no-store" } });
    }
    if (operation === "application_audit") {
      const application = await cloudflareMigrationReadinessReport();
      return NextResponse.json({ application }, { headers: { "Cache-Control": "no-store" } });
    }
    if (operation === "billing_audit") {
      const billing = await stripeCutoverReadinessReport();
      return NextResponse.json({ billing }, { headers: { "Cache-Control": "no-store" } });
    }
    if (operation !== "password_import" || !Array.isArray(body.credentials)) {
      return safeJsonError("Send a supported, confirmed migration action.", 400);
    }
    const parsedCredentials = body.credentials.map(parseImportedPasswordCredential);
    if (parsedCredentials.some((credential) => credential === null)) {
      return safeJsonError("The source batch contains an invalid password credential.", 400);
    }
    const credentials = parsedCredentials.filter((credential) => credential !== null);
    const imported = await importNativePasswordCredentialBatch(credentials);
    if (imported.status !== "stored") {
      return safeJsonError("The source credentials do not all match existing Cloudflare accounts. Nothing was certified.", 409);
    }
    const manifest = await passwordProofManifest(credentials);
    if (!manifest) return safeJsonError("The source batch cannot produce a valid migration commitment.", 400);
    const evidence = await certifyNativePasswordMigration(credentials.length, manifest);
    if (evidence.status !== "verified" || evidence.sourceRows !== credentials.length || evidence.importedRows !== credentials.length) {
      return safeJsonError("The password batch was written but its exact source-to-D1 certificate was not verified.", 409);
    }
    return NextResponse.json({
      verified: true,
      sourceRows: evidence.sourceRows,
      importedRows: evidence.importedRows,
      verifiedAt: evidence.verifiedAt,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return safeJsonError("The migration action could not be verified. No cutover setting was changed.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const POST = withCors(handlePOST);
