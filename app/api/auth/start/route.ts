import { NextResponse } from "next/server";
import { authorizeUrl, isOAuthProvider } from "@/lib/auth/oauth";
import { logInternal } from "@/lib/auth/errors";
import { withCors } from "@/lib/http/cors";
import { nativeAuthCutoverActive } from "@/lib/cloudflare/native-auth-readiness";
import { appleOAuthServerFlowConfigured } from "@/lib/auth/apple-oauth-server";

/*
  Starts a provider handshake. Pre-cutover accounts redirect through Supabase;
  once the Cloudflare-native authority is live, Google goes directly to Google
  and Apple goes directly to Apple — the latter only where this Worker actually
  holds Apple's credentials, since without them there is no direct flow to send
  anybody to.

  The browser cannot build this URL itself — it does not know the project URL,
  and that is the point (see lib/auth/oauth.ts). So it asks for a provider by
  name and gets a 302 or nothing.
*/

export const dynamic = "force-dynamic";

async function handleGET(req: Request) {
  const url = new URL(req.url);
  const provider = url.searchParams.get("provider");

  /*
    An unknown provider is a 400 and no more. Echoing the value back would
    reflect attacker-controlled text into a response; naming the ones that do
    exist would turn this into a discovery endpoint.
  */
  if (!isOAuthProvider(provider)) {
    return NextResponse.json({ error: "Unknown sign-in method." }, { status: 400 });
  }

  /*
    Once a Cloudflare-native identity is active, Google must never fall back
    through Supabase. The dedicated route either starts the direct Google
    server flow or answers safely if that deployment is incomplete.
  */
  if (provider === "google" && nativeAuthCutoverActive()) {
    return NextResponse.redirect(new URL("/api/auth/google/start", url), { status: 302 });
  }

  /*
    And the same for Apple, once there is a direct Apple flow to send it to.

    The condition is the extra one: Google's direct flow exists wherever the
    cutover does, but Apple's needs four credentials that may simply not be
    there — so this asks whether the destination works rather than assuming it,
    and falls through to Supabase when it does not.

    Nothing in the app follows this path any more; AppleSignIn addresses
    /api/auth/apple/start itself. It is here for the page that was loaded before
    a deploy and clicked after one, which would otherwise be sent through a
    Supabase handshake this deployment has stopped honouring.
  */
  if (provider === "apple" && nativeAuthCutoverActive() && appleOAuthServerFlowConfigured()) {
    return NextResponse.redirect(new URL("/api/auth/apple/start", url), { status: 302 });
  }

  /*
    `url.origin` comes from the request, which on Workers is reconstructed
    from the Host header. That is enough to send the user back to the host
    they started on, and it is not enough to be dangerous on its own: Supabase
    refuses any redirect_to outside the project's configured allow list, so a
    forged Host produces a failed sign-in rather than a redirect to an
    attacker. The allow list is the control; this is the convenience.
  */
  const target = authorizeUrl(provider, url.origin);

  if (!target) {
    // Accounts are off or unconfigured. Same answer either way, and the same
    // answer an unrouted path would give, so nothing is learned by asking.
    logInternal("auth/start", new Error(`sign-in requested while accounts are unavailable`));
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  return NextResponse.redirect(target, { status: 302 });
}


/*
  CORS lives on the route now rather than in proxy.ts, which cannot run on
  Cloudflare. Same behaviour, different place — see lib/http/cors.ts.
*/
export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
