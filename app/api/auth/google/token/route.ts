import { NextResponse } from "next/server";
import {
  accountsEnabled,
  bandUpSessionSigningKey,
  googleClientId,
  googleIosClientId,
} from "@/lib/auth/env";
import { logInternal, safeJsonError } from "@/lib/auth/errors";
import { verifyGoogleIdToken } from "@/lib/auth/google-token";
import { signInWithGoogleIdToken, supabaseConfigured } from "@/lib/auth/supabase";
import { createGoogleNativeSession } from "@/lib/cloudflare/native-identity";
import { nativeAuthCutoverActive } from "@/lib/cloudflare/native-auth-readiness";
import { withCors } from "@/lib/http/cors";

export const dynamic = "force-dynamic";

interface Body {
  credential?: unknown;
  nonce?: unknown;
}

async function handlePOST(req: Request) {
  const clientId = googleClientId();
  const nativeActive = nativeAuthCutoverActive();
  if (!accountsEnabled() || (!nativeActive && !supabaseConfigured()) || !clientId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  let body: Body | null;
  try {
    body = (await req.json()) as Body;
  } catch {
    body = null;
  }

  const credential = typeof body?.credential === "string" ? body.credential : "";
  const nonce = typeof body?.nonce === "string" ? body.nonce : "";
  if (!credential || credential.length > 16_384 || !nonce || nonce.length > 256) {
    return safeJsonError("Google sign-in could not be completed. Please try again.", 400);
  }

  if (nativeActive) {
    const signingKey = bandUpSessionSigningKey();
    if (!signingKey) {
      logInternal("auth/google/native", new Error("native auth is enabled without a session signing key"));
      return safeJsonError("Google sign-in could not be completed. Please try again.", 503);
    }
    /*
      Both of this project's Google clients. A token names one audience, and
      which one depends on where the sign-in happened: the website's button
      mints for the web client, the app's own sheet for the iOS client. See
      lib/auth/env.ts.
    */
    const identity = await verifyGoogleIdToken(
      credential,
      [clientId, googleIosClientId()].filter((value): value is string => Boolean(value)),
      nonce,
    );
    if (!identity) {
      return safeJsonError("Google sign-in could not be completed. Please try again.", 401);
    }
    try {
      const session = await createGoogleNativeSession(identity, signingKey);
      if (!session) {
        return safeJsonError("Google sign-in could not be completed. Please try again.", 401);
      }
      return NextResponse.json(session);
    } catch (error) {
      logInternal("auth/google/native", error);
      return safeJsonError("Google sign-in could not be completed. Please try again.", 503);
    }
  }

  const session = await signInWithGoogleIdToken(credential, nonce);
  if (!session) {
    return safeJsonError("Google sign-in could not be completed. Please try again.", 401);
  }

  return NextResponse.json({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.expiresIn ? Date.now() + session.expiresIn * 1000 : null,
    email: session.email,
  });
}

export { OPTIONS } from "@/lib/http/cors";
export const POST = withCors(handlePOST);
