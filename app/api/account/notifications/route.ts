import { NextResponse } from "next/server";
import { accountsEnabled } from "@/lib/auth/env";
import { logInternal, MESSAGES, safeJsonError } from "@/lib/auth/errors";
import { getSessionUser } from "@/lib/auth/session";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { organizationDataMode } from "@/lib/cloudflare/bindings";
import {
  listCloudflareNotifications,
  markCloudflareNotificationsRead,
  normalizeNotificationLimit,
  parseNotificationCursor,
} from "@/lib/cloudflare/notifications";
import { withCors } from "@/lib/http/cors";
import {
  isOrganizationPreviewRequest,
  organizationPreviewUser,
} from "@/lib/organizations/preview-auth";

export const dynamic = "force-dynamic";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 2 * 1024;
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

async function requireUser(req: Request) {
  const previewRequest = isOrganizationPreviewRequest(req);
  const previewUser = organizationPreviewUser(req);
  if (previewUser) return { user: previewUser, preview: true };
  if (previewRequest) return { error: "preview_role" as const };
  if (!accountsEnabled() || !supabaseConfigured()) return { error: "off" as const };
  const user = await getSessionUser(req).catch(() => null);
  return user ? { user, preview: false } : { error: "anon" as const };
}

async function handleGET(req: Request) {
  const auth = await requireUser(req);
  if (auth.error === "preview_role") return safeJsonError("Invalid preview role.", 400);
  if (auth.error === "off") return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (auth.error === "anon") return safeJsonError(MESSAGES.signInRequired, 401);

  const search = new URL(req.url).searchParams;
  const limit = normalizeNotificationLimit(search.get("limit"));
  const cursor = parseNotificationCursor(search.get("cursor"));
  if (limit === 0 || cursor === "invalid") return safeJsonError("Invalid notification page.", 400);

  // Before organization cutover there is no D1 notification authority. An
  // empty private inbox is safer than falling back to a second, drifting copy.
  if (organizationDataMode() === "supabase" && !auth.preview) {
    return NextResponse.json(
      { notifications: [], unreadCount: 0, nextCursor: null },
      { headers: PRIVATE_HEADERS },
    );
  }

  try {
    return NextResponse.json(
      await listCloudflareNotifications(auth.user, { limit, cursor }),
      { headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    logInternal("account/notifications GET", error);
    return safeJsonError("Notifications aren't available right now. Please try again.", 503);
  }
}

async function handlePOST(req: Request) {
  const auth = await requireUser(req);
  if (auth.error === "preview_role") {
    return safeJsonError("This shared preview is read-only.", 403);
  }
  if (auth.error === "off") return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (auth.error === "anon") return safeJsonError(MESSAGES.signInRequired, 401);
  if (auth.preview) return safeJsonError("This shared preview is read-only.", 403);
  if (organizationDataMode() === "supabase") return safeJsonError("Notifications aren't available yet.", 409);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return safeJsonError("That request is too large.", 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return safeJsonError("Invalid request.", 400);
  }
  const input = body as { action?: unknown; notificationId?: unknown };
  let notificationId: string | null;
  if (input.action === "mark_all_read") {
    notificationId = null;
  } else if (input.action === "mark_read" && typeof input.notificationId === "string" && ID.test(input.notificationId)) {
    notificationId = input.notificationId;
  } else {
    return safeJsonError("Invalid notification action.", 400);
  }

  try {
    const unreadCount = await markCloudflareNotificationsRead(auth.user, notificationId);
    return NextResponse.json({ ok: true, unreadCount }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    logInternal("account/notifications POST", error);
    return safeJsonError("That notification wasn't updated. Please try again.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
export const POST = withCors(handlePOST);
