import { NextResponse } from "next/server";
import { accountsEnabled } from "@/lib/auth/env";
import { appleOAuthServerFlowConfigured } from "@/lib/auth/apple-oauth-server";
import { nativeAuthCutoverActive } from "@/lib/cloudflare/native-auth-readiness";
import { withCors } from "@/lib/http/cors";

/*
  Whether this deployment can sign anybody in with Apple, answered before a
  button is drawn rather than after one is tapped.

  It carries no client id, unlike its Google counterpart, because the browser
  never talks to Apple directly here. Google's button is Google's own script
  running on this page, so the page needs the client id; Apple's is a plain
  full-page redirect through /api/auth/apple/start, so the only identifier
  involved stays on the Worker. That is one fewer public value and one fewer
  script, and it is also why there is nothing here to leak.

  `{ enabled: false }` is the honest answer in the deployment this was written
  for, and it is what makes the absence graceful: AppleSignIn.tsx renders
  nothing at all on a false, so a learner is never offered a door that opens
  onto a 404.
*/

export const dynamic = "force-dynamic";

async function handleGET() {
  const nativeActive = nativeAuthCutoverActive();
  if (!accountsEnabled() || !nativeActive || !appleOAuthServerFlowConfigured()) {
    return NextResponse.json({ enabled: false });
  }

  return NextResponse.json({
    enabled: true,
    /*
      Both true together, always, and kept as two fields anyway so this answer
      reads the same way as /api/auth/google/config. `native` says the
      Cloudflare authority is live and `serverFlow` says this Worker holds the
      Apple credentials; Apple has no pre-cutover path of its own to fall back
      to, so a deployment where these could disagree does not exist.
    */
    native: true,
    serverFlow: true,
  });
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
