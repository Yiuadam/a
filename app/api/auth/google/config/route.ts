import { NextResponse } from "next/server";
import { accountsEnabled, googleClientId } from "@/lib/auth/env";
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
    native: nativeActive,
    // This lets a client choose the reliable full-page fallback only after
    // the Cloudflare-native authority is live; it reveals no secret.
    serverFlow: nativeActive && googleOAuthServerFlowConfigured(),
  });
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
