import { NextResponse } from "next/server";
import { accountsEnabled, bandUpSessionSigningKey } from "@/lib/auth/env";
import { logInternal } from "@/lib/auth/errors";
import { isNativeSessionRequest } from "@/lib/auth/session";
import { revokeNativeBrowserSessionToken } from "@/lib/cloudflare/native-identity";
import { withCors } from "@/lib/http/cors";

export const dynamic = "force-dynamic";

/**
 * Supabase sessions remain a local-browser sign-out until the migration is
 * complete. Native sessions are also revoked in D1 so the access token stops
 * working immediately, rather than only when its one-hour expiry arrives.
 */
async function handlePOST(req: Request) {
  if (!accountsEnabled()) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!isNativeSessionRequest(req)) return new NextResponse(null, { status: 204 });

  const token = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization")?.trim() ?? "")?.[1]?.trim();
  const signingKey = bandUpSessionSigningKey();
  if (!token || !signingKey) return new NextResponse(null, { status: 204 });
  try {
    await revokeNativeBrowserSessionToken(token, signingKey);
  } catch (error) {
    // Local sign-out must still complete. The token expires in an hour and
    // the browser token is removed even if the best-effort server revocation
    // cannot reach D1.
    logInternal("auth/signout/native", error);
  }
  return new NextResponse(null, { status: 204 });
}

export { OPTIONS } from "@/lib/http/cors";
export const POST = withCors(handlePOST);
