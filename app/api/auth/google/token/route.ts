import { NextResponse } from "next/server";
import {
  accountsEnabled,
  bandUpSessionSigningKey,
  googleClientId,
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
    const identity = await verifyGoogleIdToken(credential, clientId, nonce);
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
