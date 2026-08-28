import { NextResponse } from "next/server";
import { accountsEnabled, bandUpSessionSigningKey } from "@/lib/auth/env";
import { supabaseConfigured, refreshAccessToken } from "@/lib/auth/supabase";
import { logInternal } from "@/lib/auth/errors";
import { refreshNativeBrowserSession } from "@/lib/cloudflare/native-identity";
import { nativeAuthCutoverActive } from "@/lib/cloudflare/native-auth-readiness";
import { withCors } from "@/lib/http/cors";

/*
  Renews an access token.

  Without this the session lasts as long as one access token — an hour by
  Supabase's default — and a learner mid-way through a mock speaking test is
  signed out with no explanation. The refresh token is held by the browser
  alongside the access token and spent here, where the anon key lives.
*/

export const dynamic = "force-dynamic";

async function handlePOST(req: Request) {
  const nativeActive = nativeAuthCutoverActive();
  if (!accountsEnabled() || (!nativeActive && !supabaseConfigured())) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const token = (body as { refresh_token?: unknown } | null)?.refresh_token;
  if (typeof token !== "string" || token.length === 0) {
    return NextResponse.json({ error: "Signed out." }, { status: 401 });
  }

  if (nativeActive) {
    const signingKey = bandUpSessionSigningKey();
    if (!signingKey) {
      logInternal("auth/refresh/native", new Error("native auth is enabled without a session signing key"));
      return NextResponse.json({ error: "Signed out." }, { status: 401 });
    }
    try {
      const session = await refreshNativeBrowserSession(token, signingKey);
      if (!session) return NextResponse.json({ error: "Signed out." }, { status: 401 });
      return NextResponse.json(session);
    } catch (error) {
      logInternal("auth/refresh/native", error);
      return NextResponse.json({ error: "Signed out." }, { status: 401 });
    }
  }

  const session = await refreshAccessToken(token);
  if (!session) {
    /*
      401 rather than 500 even when the cause was an outage. The client's only
      sensible response to either is to sign out and offer sign-in again, and
      distinguishing them here would tell an unauthenticated caller whether a
      given refresh token was real.
    */
    logInternal("auth/refresh", new Error("refresh rejected"));
    return NextResponse.json({ error: "Signed out." }, { status: 401 });
  }

  return NextResponse.json({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.expiresIn ? Date.now() + session.expiresIn * 1000 : null,
    email: session.email,
  });
}


/*
  CORS lives on the route now rather than in proxy.ts, which cannot run on
  Cloudflare. Same behaviour, different place — see lib/http/cors.ts.
*/
export { OPTIONS } from "@/lib/http/cors";
export const POST = withCors(handlePOST);
