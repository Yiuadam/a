import { NextResponse } from "next/server";
import { accountsEnabled, googleClientId } from "@/lib/auth/env";
import { safeJsonError } from "@/lib/auth/errors";
import { signInWithGoogleIdToken, supabaseConfigured } from "@/lib/auth/supabase";
import { withCors } from "@/lib/http/cors";

export const dynamic = "force-dynamic";

interface Body {
  credential?: unknown;
  nonce?: unknown;
}

async function handlePOST(req: Request) {
  if (!accountsEnabled() || !supabaseConfigured() || !googleClientId()) {
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
