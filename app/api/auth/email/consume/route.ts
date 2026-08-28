import { NextResponse } from "next/server";
import { accountsEnabled, bandUpSessionSigningKey } from "@/lib/auth/env";
import { safeJsonError } from "@/lib/auth/errors";
import { consumeNativeEmailAction } from "@/lib/auth/native-email";
import { nativeAuthCutoverActive } from "@/lib/cloudflare/native-auth-readiness";
import { withCors } from "@/lib/http/cors";

export const dynamic = "force-dynamic";

interface Body {
  token?: unknown;
  action?: unknown;
}

async function handlePOST(request: Request) {
  if (!accountsEnabled() || !nativeAuthCutoverActive()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const signingKey = bandUpSessionSigningKey();
  if (!signingKey) return safeJsonError("That sign-in link is unavailable. Please request another one.", 503);

  let body: Body | null = null;
  try {
    body = await request.json() as Body;
  } catch {
    // The same invalid-link response below covers malformed JSON as well.
  }
  try {
    const session = await consumeNativeEmailAction(body?.token, body?.action, signingKey);
    if (!session) return safeJsonError("That sign-in link has expired or was already used. Please request another one.", 400);
    return NextResponse.json(session, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch {
    /* The token is user-controlled secret material. Never put an underlying
       D1 or email detail in the log path for a failed consume. */
    return safeJsonError("That sign-in link is unavailable. Please request another one.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const POST = withCors(handlePOST);
