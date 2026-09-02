import { NextResponse } from "next/server";
import { logInternal, safeJsonError } from "@/lib/auth/errors";
import { nativeAuthCutoverActive } from "@/lib/cloudflare/native-auth-readiness";
import { startAppleOAuthServerFlow } from "@/lib/auth/apple-oauth-server";
import { withCors } from "@/lib/http/cors";

/*
  The one door to Apple from the website.

  Gated on the Cloudflare-native authority for the same reason
  /api/auth/google/start is: before cutover the only account authority that
  understands an Apple identity is Supabase, reached through
  /api/auth/start?provider=apple, and writing a D1 state row that no live
  callback could ever consume would strand every learner who tapped it.

  A 404 rather than an explanation, whether the reason is the cutover, a missing
  credential or accounts being off entirely. An endpoint that answers
  differently depending on which of those it is tells a prober the feature is
  there and merely switched off.
*/

export const dynamic = "force-dynamic";

async function handleGET(request: Request) {
  if (!nativeAuthCutoverActive()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  try {
    const target = await startAppleOAuthServerFlow(request);
    if (!target) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.redirect(target, { status: 302 });
  } catch (error) {
    logInternal("auth/apple/start", error);
    return safeJsonError("Apple sign-in could not be started. Please try again.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
