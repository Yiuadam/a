import { NextResponse } from "next/server";
import { authorizeUrl, isOAuthProvider } from "@/lib/auth/oauth";
import { logInternal } from "@/lib/auth/errors";
import { withCors } from "@/lib/http/cors";
import { nativeAuthCutoverActive } from "@/lib/cloudflare/native-auth-readiness";

/*
  Starts a provider handshake. Apple and pre-cutover accounts redirect through
  Supabase; Cloudflare-native Google accounts redirect directly to Google.

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
