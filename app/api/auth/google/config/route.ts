import { NextResponse } from "next/server";
import { accountsEnabled, googleClientId, googleIosClientId } from "@/lib/auth/env";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { nativeAuthCutoverActive } from "@/lib/cloudflare/native-auth-readiness";
import { googleOAuthServerFlowConfigured } from "@/lib/auth/google-oauth-server";
import { withCors } from "@/lib/http/cors";

export const dynamic = "force-dynamic";

async function handleGET() {
  const clientId = googleClientId();
  const nativeActive = nativeAuthCutoverActive();
  if (!accountsEnabled() || (!nativeActive && !supabaseConfigured()) || !clientId) {
    return NextResponse.json({ enabled: false });
  }

  return NextResponse.json({
    enabled: true,
    clientId,
    /*
      The app's own Google client, when one exists. Absent means the app has no
      native sign-in to offer and must not draw a button for one — see
      components/account/SignedOut.tsx, where a Google button that cannot work
      is worse than no Google button.

      No secret: an iOS OAuth client has none, because a secret inside an app
      is not a secret. This is the same kind of value as `clientId` above.
    */
    iosClientId: googleIosClientId() ?? null,
    native: nativeActive,
    // This lets a client choose the reliable full-page fallback only after
    // the Cloudflare-native authority is live; it reveals no secret.
    serverFlow: nativeActive && googleOAuthServerFlowConfigured(),
  });
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
