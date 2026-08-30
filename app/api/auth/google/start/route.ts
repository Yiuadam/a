import { NextResponse } from "next/server";
import { logInternal, safeJsonError } from "@/lib/auth/errors";
import { nativeAuthCutoverActive } from "@/lib/cloudflare/native-auth-readiness";
import { startGoogleOAuthServerFlow } from "@/lib/auth/google-oauth-server";
import { withCors } from "@/lib/http/cors";

export const dynamic = "force-dynamic";

async function handleGET(request: Request) {
  // The direct server flow only becomes available with the Cloudflare-native
  // account authority. Before that, GoogleSignIn keeps using the compatibility
  // flow rather than creating a D1 state row that no deployed callback knows.
  if (!nativeAuthCutoverActive()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  try {
    const target = await startGoogleOAuthServerFlow(request);
    if (!target) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.redirect(target, { status: 302 });
  } catch (error) {
    logInternal("auth/google/start", error);
    return safeJsonError("Google sign-in could not be started. Please try again.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
