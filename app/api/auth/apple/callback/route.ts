import { NextResponse } from "next/server";
import { bandUpSessionSigningKey } from "@/lib/auth/env";
import { logInternal } from "@/lib/auth/errors";
import { verifyAppleIdToken } from "@/lib/auth/apple-token";
import {
  appleDisplayName,
  appleOAuthCallbackUrl,
  appleTokenAudiences,
  consumeAppleOAuthState,
  exchangeAppleAuthorizationCode,
  parseAppleUserField,
} from "@/lib/auth/apple-oauth-server";
import { createAppleNativeSession } from "@/lib/cloudflare/native-identity";
import { nativeAuthCutoverActive } from "@/lib/cloudflare/native-auth-readiness";
import { withCors } from "@/lib/http/cors";

/*
  Where Apple returns an authorization, which it does by POSTing a form.

  This is the one structural difference from the Google callback and it is not
  optional: asking Apple for a name or an email obliges the authorize request to
  carry `response_mode=form_post`, and Apple then answers with a POST body
  instead of a redirect with a query string. So there is no GET handler here at
  all — a GET is not a flow this route has, and answering one would only invite
  somebody to look for what it does.

  The `user` field in that body is the reason the name is captured here rather
  than anywhere more convenient. Apple includes it on the first authorization of
  this app by this person and never again. This request is the only chance.
*/

export const dynamic = "force-dynamic";

function failed(appOrigin: string): NextResponse {
  return NextResponse.redirect(
    appleOAuthCallbackUrl(appOrigin, {
      error: "apple_sign_in_failed",
      error_description: "Apple sign-in could not be completed. Please try again.",
    }),
    /*
      303 rather than the 302 the Google callback uses, because this response is
      answering a POST. A 302 leaves the method up to the browser — every one of
      them turns it into a GET in practice, and none of them promises to — while
      303 is defined as "go and GET this instead", which is exactly what the
      account callback page needs to happen. The same reasoning applies to the
      success redirect below.
    */
    { status: 303 },
  );
}

async function handlePOST(request: Request) {
  if (!nativeAuthCutoverActive()) return NextResponse.json({ error: "Not found." }, { status: 404 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid sign-in response." }, { status: 400 });
  }

  const field = (name: string): string => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };

  const state = field("state");
  let transaction: { nonce: string; appOrigin: string } | null = null;
  try {
    transaction = await consumeAppleOAuthState(state);
  } catch (error) {
    logInternal("auth/apple/callback-state", error);
  }
  /*
    Consumed before anything else is looked at, including the error field. A
    form post that cannot present an unspent state is not a sign-in this Worker
    started, and it gets the same flat 400 whether it is a replay, a stale tab
    or an outright forgery.
  */
  if (!transaction) return NextResponse.json({ error: "Invalid sign-in response." }, { status: 400 });

  if (form.has("error")) return failed(transaction.appOrigin);
  const code = field("code");
  const audiences = appleTokenAudiences();
  const signingKey = bandUpSessionSigningKey();
  if (!code || audiences.length === 0 || !signingKey) return failed(transaction.appOrigin);

  try {
    const exchanged = await exchangeAppleAuthorizationCode(code, transaction.appOrigin);
    if (!exchanged) return failed(transaction.appOrigin);
    /*
      "raw" because Apple echoes the nonce it was given rather than hashing it,
      and the web flow gives it the value straight out of the D1 row. The native
      flow is the one that hashes, on the device, and it verifies elsewhere.
    */
    const identity = await verifyAppleIdToken(
      exchanged.idToken,
      audiences,
      transaction.nonce,
      Date.now(),
      "raw",
    );
    if (!identity) return failed(transaction.appOrigin);

    const session = await createAppleNativeSession(
      identity,
      appleDisplayName(parseAppleUserField(form.get("user") as string | null)),
      signingKey,
    );
    if (!session) return failed(transaction.appOrigin);
    return NextResponse.redirect(
      appleOAuthCallbackUrl(transaction.appOrigin, {
        access_token: session.accessToken,
        refresh_token: session.refreshToken,
        expires_in: String(Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1_000))),
      }),
      { status: 303 },
    );
  } catch (error) {
    logInternal("auth/apple/callback", error);
    return failed(transaction.appOrigin);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const POST = withCors(handlePOST);
