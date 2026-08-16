import { NextResponse } from "next/server";
import { billingHealth } from "@/lib/billing/health";
import { withCors } from "@/lib/http/cors";

/*
  Is billing actually wired end to end — booleans only, to anyone who asks.

  See lib/billing/health.ts for why an unauthenticated route is the right
  shape here and why it stays boolean-only where
  app/api/account/diagnostics/route.ts is allowed to explain itself: this one
  is called by .github/workflows/deploy-cloudflare.yml, straight after every
  deploy, with no session to hold a token for it to authenticate.

  Never cached — a stale "healthy" served from an edge cache during the exact
  outage this route exists to catch would be worse than no check at all.
*/

export const dynamic = "force-dynamic";

async function handleGET() {
  const health = await billingHealth();
  return NextResponse.json(health, {
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
