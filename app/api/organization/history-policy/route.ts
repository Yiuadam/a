import { NextResponse } from "next/server";
import { accountsEnabled } from "@/lib/auth/env";
import { logInternal, MESSAGES, safeJsonError } from "@/lib/auth/errors";
import { getSessionUser } from "@/lib/auth/session";
import {
  organizationHistoryClearPolicy,
  supabaseConfigured,
} from "@/lib/auth/supabase";
import { organizationDataMode } from "@/lib/cloudflare/bindings";
import { cloudflareHistoryClearAllowed } from "@/lib/cloudflare/organizations";
import { withCors } from "@/lib/http/cors";
import { organizationPreviewUser } from "@/lib/organizations/preview-auth";

export const dynamic = "force-dynamic";

async function handleGET(req: Request) {
  const previewUser = organizationPreviewUser(req);
  if (!previewUser && (!accountsEnabled() || !supabaseConfigured())) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const user = previewUser ?? await getSessionUser(req).catch(() => null);
  if (!user) return safeJsonError(MESSAGES.signInRequired, 401);

  const policy = organizationDataMode() === "cloudflare"
    ? await cloudflareHistoryClearAllowed(user)
        .then((allowed) => allowed ? "allowed" as const : "restricted" as const)
        .catch(() => "unavailable" as const)
    : await organizationHistoryClearPolicy(user.id);
  if (policy === "unavailable") {
    logInternal("organization history policy", new Error("policy lookup unavailable"));
    return safeJsonError("History settings could not be checked just now.", 503);
  }

  return NextResponse.json(
    {
      // Before the atomic organization migration exists, memberships cannot
      // exist either, so independent accounts retain their existing control.
      canClearOwnHistory: policy !== "restricted",
    },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } },
  );
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
