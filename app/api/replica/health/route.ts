import { NextResponse } from "next/server";
import { cloudflareReplicaHealth } from "@/lib/cloudflare/replica-health";
import { withCors } from "@/lib/http/cors";

/*
  Is the D1/R2 mirror still being drained — booleans only, to anyone who asks.

  See lib/cloudflare/replica-health.ts for why this is unauthenticated and why
  it stays boolean-only: .github/workflows/replica-health.yml calls it hourly
  with no session to hold a token for it, exactly as the billing health check
  is called, and the detail behind a failed check belongs to the admin routes.

  Never cached. A stale "healthy" served from an edge cache during the exact
  stall this route exists to catch would be worse than no check at all.
*/

export const dynamic = "force-dynamic";

async function handleGET() {
  const health = await cloudflareReplicaHealth();
  return NextResponse.json(health, {
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
