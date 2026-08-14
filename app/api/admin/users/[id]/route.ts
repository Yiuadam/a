import { accountsEnabled, isAdminEmail } from "@/lib/auth/env";
import { getSessionUser } from "@/lib/auth/session";
import { safeJsonError } from "@/lib/auth/errors";
import { rpc, supabaseConfigured } from "@/lib/auth/supabase";
import { withCors } from "@/lib/http/cors";
import { applyOwnerEffectiveAccessToDetail } from "@/lib/admin/effective-access";
import { getLearnerProgressSnapshots } from "@/lib/cloudflare/data-router";
import { cloudflareDataMode } from "@/lib/cloudflare/bindings";
import { adminProgressFromSnapshots } from "@/lib/admin/user-progress";
import { organizationDataMode } from "@/lib/cloudflare/bindings";
import { cloudflareAdminOrganizationSeats } from "@/lib/cloudflare/admin-organization-access";

export const dynamic = "force-dynamic";

interface AdminUserDetail {
  id: string;
  email: string | null;
  plan: string;
  accessSource?: string | null;
  placement?: unknown;
  mockReports?: unknown;
  drillScores?: unknown;
  results?: unknown;
  profileSyncedAt?: string | null;
  drillsSyncedAt?: string | null;
  progressAvailable?: boolean;
  [key: string]: unknown;
}

async function handleGET(req: Request, context: RouteContext<"/api/admin/users/[id]">) {
  if (!accountsEnabled() || !supabaseConfigured()) return safeJsonError("Not found.", 404);
  const actor = await getSessionUser(req).catch(() => null);
  if (!actor || !isAdminEmail(actor.email)) return safeJsonError("Not found.", 404);
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return safeJsonError("Not found.", 404);
  try {
    const user = await rpc<AdminUserDetail | null>("admin_user_detail", { p_user_id: id });
    if (!user) return safeJsonError("Not found.", 404);
    const effective = applyOwnerEffectiveAccessToDetail(user);
    const organizationSeats = organizationDataMode() === "cloudflare"
      ? (await cloudflareAdminOrganizationSeats([user.id])).get(user.id) ?? []
      : undefined;
    const snapshots = await getLearnerProgressSnapshots({ id: user.id, email: user.email });
    const progress = adminProgressFromSnapshots(
      snapshots,
      cloudflareDataMode() === "cloudflare",
    );
    return Response.json({
      ...effective,
      ...(organizationSeats ? { organizationSeats } : {}),
      ...(progress ?? { progressAvailable: true }),
    });
  } catch {
    return safeJsonError("This account history is unavailable right now.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
