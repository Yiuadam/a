import { NextResponse } from "next/server";
import { bandUpSessionSigningKey, googleClientId } from "@/lib/auth/env";
import { logInternal } from "@/lib/auth/errors";
import { verifyGoogleIdToken } from "@/lib/auth/google-token";
import {
  consumeGoogleOAuthState,
  exchangeGoogleAuthorizationCode,
  googleOAuthCallbackUrl,
} from "@/lib/auth/google-oauth-server";
import { createGoogleNativeSession } from "@/lib/cloudflare/native-identity";
import { nativeAuthCutoverActive } from "@/lib/cloudflare/native-auth-readiness";
import { withCors } from "@/lib/http/cors";

export const dynamic = "force-dynamic";

function failed(appOrigin: string): NextResponse {
  return NextResponse.redirect(
    googleOAuthCallbackUrl(appOrigin, {
      error: "google_sign_in_failed",
      error_description: "Google sign-in could not be completed. Please try again.",
    }),
    { status: 302 },
  );
}

async function handleGET(request: Request) {
  if (!nativeAuthCutoverActive()) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  let transaction: { nonce: string; appOrigin: string } | null = null;
  try {
    transaction = await consumeGoogleOAuthState(state);
  } catch (error) {
    logInternal("auth/google/callback-state", error);
  }
  if (!transaction) return NextResponse.json({ error: "Invalid sign-in response." }, { status: 400 });

  if (url.searchParams.has("error")) return failed(transaction.appOrigin);
  const code = url.searchParams.get("code") ?? "";
  const clientId = googleClientId();
  const signingKey = bandUpSessionSigningKey();
  if (!code || !clientId || !signingKey) return failed(transaction.appOrigin);

  try {
    const exchanged = await exchangeGoogleAuthorizationCode(code, transaction.appOrigin);
    if (!exchanged) return failed(transaction.appOrigin);
    const identity = await verifyGoogleIdToken(
      exchanged.idToken,
      clientId,
      transaction.nonce,
      Date.now(),
      "raw",
    );
    if (!identity) return failed(transaction.appOrigin);
    const session = await createGoogleNativeSession(identity, signingKey);
    if (!session) return failed(transaction.appOrigin);
    return NextResponse.redirect(
      googleOAuthCallbackUrl(transaction.appOrigin, {
        access_token: session.accessToken,
        refresh_token: session.refreshToken,
        expires_in: String(Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1_000))),
      }),
      { status: 302 },
    );
  } catch (error) {
    logInternal("auth/google/callback", error);
    return failed(transaction.appOrigin);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
