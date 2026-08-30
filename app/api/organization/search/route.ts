import { NextResponse } from "next/server";
import { logInternal, MESSAGES, safeJsonError } from "@/lib/auth/errors";
import { getSessionUser } from "@/lib/auth/session";
import { accountRuntimeEnabled } from "@/lib/auth/runtime";
import { withCors } from "@/lib/http/cors";
import { organizationDiscovery } from "@/lib/organizations/discovery";
import {
  isOrganizationPreviewRequest,
  organizationPreviewUser,
} from "@/lib/organizations/preview-auth";

export const dynamic = "force-dynamic";

async function handleGET(req: Request) {
  const previewRequest = isOrganizationPreviewRequest(req);
  const previewUser = organizationPreviewUser(req);
  if (previewRequest && !previewUser) return safeJsonError("Invalid preview role.", 400);
  if (!previewUser && !accountRuntimeEnabled()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const user = previewUser ?? await getSessionUser(req).catch(() => null);
  if (!user) return safeJsonError(MESSAGES.signInRequired, 401);

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind");
  const query = url.searchParams.get("q") ?? "";
  const organizationId = url.searchParams.get("organization");
  if (kind !== "user" && kind !== "organization") return safeJsonError("Invalid search.", 400);
  if (query.length > 80) return safeJsonError("Search is too long.", 400);
  if (organizationId && !/^[0-9a-f-]{36}$/i.test(organizationId)) {
    return safeJsonError("Invalid organisation.", 400);
  }

  try {
    const result = await organizationDiscovery(user, kind, query, organizationId);
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    logInternal(`organization search:${kind}`, error);
    return safeJsonError("Search is unavailable just now. Try again.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
