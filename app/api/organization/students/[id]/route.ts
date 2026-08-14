import { after, NextResponse } from "next/server";
import { accountsEnabled } from "@/lib/auth/env";
import { logInternal, MESSAGES, safeJsonError } from "@/lib/auth/errors";
import { getSessionUser } from "@/lib/auth/session";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { withCors } from "@/lib/http/cors";
import { organizationPreviewUser } from "@/lib/organizations/preview-auth";
import { organizationStudentHistory } from "@/lib/organizations/server";
import { organizationDataMode } from "@/lib/cloudflare/bindings";
import { drainCloudflareOrganizationAttemptOutbox } from "@/lib/cloudflare/organization-attempt-outbox";
import { reconcileOrganizationAttemptObjects } from "@/lib/cloudflare/organization-attempt-objects";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function handleGET(req: Request, ctx: RouteContext<"/api/organization/students/[id]">) {
  const previewUser = organizationPreviewUser(req);
  if (!previewUser && (!accountsEnabled() || !supabaseConfigured())) {
    return NextResponse.json({ error: "Not found." }, {
      status: 404,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  }
  const user = previewUser ?? await getSessionUser(req).catch(() => null);
  if (!user) return safeJsonError(MESSAGES.signInRequired, 401);

  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Not found." }, {
    status: 404,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
  const searchParams = new URL(req.url).searchParams;
  const selectedOrganization = searchParams.get("organization");
  if (selectedOrganization !== null && !UUID.test(selectedOrganization)) {
    return NextResponse.json({ error: "Not found." }, {
      status: 404,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  }
  const selectedAttempt = searchParams.get("attempt");
  if (selectedAttempt !== null && !UUID.test(selectedAttempt)) {
    return NextResponse.json({ error: "Not found." }, {
      status: 404,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  }

  try {
    const history = await organizationStudentHistory(user, id, selectedOrganization, selectedAttempt);
    if (organizationDataMode() !== "supabase") {
      after(async () => {
        await drainCloudflareOrganizationAttemptOutbox({ userId: id, limit: 2 })
          .catch(() => undefined);
        await reconcileOrganizationAttemptObjects(undefined, { limit: 8 }).catch(() => undefined);
      });
    }
    return NextResponse.json(history, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    logInternal("organization student history GET", error);
    // Do not distinguish an unknown student from one outside the teacher's
    // assignment; either answer would reveal membership information.
    return NextResponse.json({ error: "Not found." }, {
      status: 404,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
