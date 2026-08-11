import { NextResponse } from "next/server";
import { accountsEnabled, googleClientId } from "@/lib/auth/env";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { withCors } from "@/lib/http/cors";

export const dynamic = "force-dynamic";

async function handleGET() {
  const clientId = googleClientId();
  if (!accountsEnabled() || !supabaseConfigured() || !clientId) {
    return NextResponse.json({ enabled: false });
  }

  return NextResponse.json({ enabled: true, clientId });
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
