import { NextResponse } from "next/server";
import { accountsEnabled, bandUpSessionSigningKey } from "@/lib/auth/env";
import { logInternal, safeJsonError } from "@/lib/auth/errors";
import { looksLikeNativeAccessToken } from "@/lib/auth/native-session";
import { supabaseConfigured, userFromAccessToken } from "@/lib/auth/supabase";
import { bridgeLegacyBrowserSession } from "@/lib/cloudflare/native-identity";
import { nativeAuthCutoverActive } from "@/lib/cloudflare/native-auth-readiness";
import { withCors } from "@/lib/http/cors";

export const dynamic = "force-dynamic";

function bearerToken(req: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization")?.trim() ?? "");
  const token = match?.[1]?.trim() ?? "";
  return token.length > 0 ? token : null;
}

/**
 * One-way, browser-initiated upgrade from a verified legacy session to the
 * D1-backed native session.  It is intentionally available only while
 * Supabase can still verify the old bearer token.  Once all active browsers
 * have crossed this bridge, removing the route is safe and does not affect
 * native refresh sessions.
 */
async function handlePOST(req: Request) {
  if (!accountsEnabled() || !nativeAuthCutoverActive() || !supabaseConfigured()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const token = bearerToken(req);
  if (!token || looksLikeNativeAccessToken(token)) {
    return NextResponse.json({ error: "Signed out." }, { status: 401 });
  }
  const signingKey = bandUpSessionSigningKey();
  if (!signingKey) {
    logInternal("auth/native-upgrade", new Error("native auth is enabled without a session signing key"));
    return safeJsonError("Your sign-in is temporarily unavailable. Please try again.", 503);
  }

  try {
    const legacyUser = await userFromAccessToken(token);
    if (!legacyUser) return NextResponse.json({ error: "Signed out." }, { status: 401 });
    const session = await bridgeLegacyBrowserSession(legacyUser, signingKey);
    if (!session) {
      /* The old session remains valid. This status is not shown to the user;
         it simply tells the client to leave the current session untouched. */
      return NextResponse.json({ error: "Account migration is still in progress." }, { status: 409 });
    }
    return NextResponse.json(session, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    logInternal("auth/native-upgrade", error);
    return safeJsonError("Your sign-in is temporarily unavailable. Please try again.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const POST = withCors(handlePOST);
