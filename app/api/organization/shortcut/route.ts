import { NextResponse } from "next/server";
import { logInternal, MESSAGES, safeJsonError } from "@/lib/auth/errors";
import { getSessionUser } from "@/lib/auth/session";
import { accountRuntimeEnabled } from "@/lib/auth/runtime";
import { withCors } from "@/lib/http/cors";
import {
  isOrganizationPreviewRequest,
  organizationPreviewUser,
} from "@/lib/organizations/preview-auth";
import { organizationHomeShortcut } from "@/lib/organizations/server";

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

  try {
    const organization = await organizationHomeShortcut(user);
    return NextResponse.json(
      { organization },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (error) {
    logInternal("organization shortcut", error);
    return safeJsonError("Your organisation could not be checked just now.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
