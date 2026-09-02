import { NextResponse } from "next/server";
import { accountsEnabled, bandUpSessionSigningKey } from "@/lib/auth/env";
import { logInternal, safeJsonError } from "@/lib/auth/errors";
import { verifyAppleIdToken } from "@/lib/auth/apple-token";
import { appleDisplayName, appleTokenAudiences } from "@/lib/auth/apple-oauth-server";
import { createAppleNativeSession } from "@/lib/cloudflare/native-identity";
import { nativeAuthCutoverActive } from "@/lib/cloudflare/native-auth-readiness";
import { withCors } from "@/lib/http/cors";

/*
  The iOS app's way in, and the only flow here with no authorization code in it.

  ASAuthorizationController hands the app a signed identity token directly, so
  there is nothing to exchange and no client secret to mint: the token is the
  whole of the evidence, and verifying it is the whole of the work. That is why
  this route needs none of the four Apple credentials except the Services ID —
  and needs that one only because it is half of the audience list.

  The name arrives here rather than being read out of the token, because it is
  not in the token. Apple populates `fullName` on the credential the first time
  a person authorizes this app and leaves it nil ever afterwards, so the plugin
  passes on whatever it was given and this route treats it as a display string
  from an untrusted client — which is exactly what it is.
*/

export const dynamic = "force-dynamic";

interface Body {
  credential?: unknown;
  nonce?: unknown;
  givenName?: unknown;
  familyName?: unknown;
}

function nameField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 60);
  return trimmed.length > 0 ? trimmed : null;
}

async function handlePOST(req: Request) {
  const audiences = appleTokenAudiences();
  /*
    404 while anything is missing, and the same 404 for every reason. Apple has
    no Supabase compatibility path in this app — the pre-cutover Apple button is
    a plain Supabase redirect that never reaches here — so unlike the Google
    token route there is no second branch below, only this gate.
  */
  if (!accountsEnabled() || !nativeAuthCutoverActive() || audiences.length === 0) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  let body: Body | null;
  try {
    body = (await req.json()) as Body;
  } catch {
    body = null;
  }

  // Named `credential` to match /api/auth/google/token, which is the shape the
  // client already knows. Apple's own name for it is `identityToken`.
  const credential = typeof body?.credential === "string" ? body.credential : "";
  const nonce = typeof body?.nonce === "string" ? body.nonce : "";
  if (!credential || credential.length > 16_384 || !nonce || nonce.length > 256) {
    return safeJsonError("Apple sign-in could not be completed. Please try again.", 400);
  }

  const signingKey = bandUpSessionSigningKey();
  if (!signingKey) {
    logInternal("auth/apple/native", new Error("native auth is enabled without a session signing key"));
    return safeJsonError("Apple sign-in could not be completed. Please try again.", 503);
  }

  /*
    "sha256" because the device hashes. The plugin generates a raw nonce, puts
    its SHA-256 hex digest on the ASAuthorizationAppleIDRequest, and sends the
    raw value here — so the raw nonce never leaves the phone by way of Apple,
    and this side hashes it again to compare. It is the same division of labour
    the Google native path uses, arrived at for the same reason.
  */
  const identity = await verifyAppleIdToken(credential, audiences, nonce, Date.now(), "sha256");
  if (!identity) {
    return safeJsonError("Apple sign-in could not be completed. Please try again.", 401);
  }

  try {
    const session = await createAppleNativeSession(
      identity,
      appleDisplayName({
        givenName: nameField(body?.givenName),
        familyName: nameField(body?.familyName),
      }),
      signingKey,
    );
    if (!session) {
      return safeJsonError("Apple sign-in could not be completed. Please try again.", 401);
    }
    return NextResponse.json(session);
  } catch (error) {
    logInternal("auth/apple/native", error);
    return safeJsonError("Apple sign-in could not be completed. Please try again.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const POST = withCors(handlePOST);
