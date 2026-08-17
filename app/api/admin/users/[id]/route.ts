import { accountsEnabled, isAdminEmail } from "@/lib/auth/env";
import { getSessionUser } from "@/lib/auth/session";
import { safeJsonError } from "@/lib/auth/errors";
import { rpc, supabaseConfigured } from "@/lib/auth/supabase";
import { withCors } from "@/lib/http/cors";
import { applyOwnerEffectiveAccessToDetail } from "@/lib/admin/effective-access";
import { getLearnerProgressSnapshots } from "@/lib/cloudflare/data-router";
import { readsFromCloudflare } from "@/lib/cloudflare/bindings";
import { adminProgressFromSnapshots } from "@/lib/admin/user-progress";
import { organizationDataMode } from "@/lib/cloudflare/bindings";
import { domainReadsFromCloudflare } from "@/lib/cloudflare/cutover-domains";
import { cloudflareAdminOrganizationSeats } from "@/lib/cloudflare/admin-organization-access";
import { cloudflareAdminDirectoryEntitlements } from "@/lib/cloudflare/admin-entitlement-directory";

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
  /** See AdminUserRow.d1_mirror_missing in app/api/admin/users/route.ts — same meaning, this account only. */
  d1MirrorMissing?: boolean;
  [key: string]: unknown;
}

async function handleGET(req: Request, context: RouteContext<"/api/admin/users/[id]">) {
  if (!accountsEnabled() || !supabaseConfigured()) return safeJsonError("Not found.", 404);
  const actor = await getSessionUser(req).catch(() => null);
  if (!actor || !isAdminEmail(actor.email)) return safeJsonError("Not found.", 404);
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return safeJsonError("Not found.", 404);
  try {
    let user = await rpc<AdminUserDetail | null>("admin_user_detail", { p_user_id: id });
    if (!user) return safeJsonError("Not found.", 404);
    if (domainReadsFromCloudflare("admin_user_directory")) {
      user = await mergeCloudflareEntitlementDetail(user);
    }
    const effective = applyOwnerEffectiveAccessToDetail(user);
    const organizationSeats = organizationDataMode() === "cloudflare"
      ? (await cloudflareAdminOrganizationSeats([user.id])).get(user.id) ?? []
      : undefined;
    const snapshots = await getLearnerProgressSnapshots({ id: user.id, email: user.email });
    const progress = adminProgressFromSnapshots(
      snapshots,
      // The same read question getLearnerProgressSnapshots() asked to
      // produce `snapshots` — this must describe where that data actually
      // came from, so it tracks readsFromCloudflare(), not a bare mode string.
      readsFromCloudflare(),
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

/**
 * Detail-page counterpart of `mergeCloudflareEntitlements` in
 * app/api/admin/users/route.ts — same D1 resolver, same "never fabricate a
 * free tier for an unmirrored account" rule, applied to one account instead
 * of a page.
 */
async function mergeCloudflareEntitlementDetail(user: AdminUserDetail): Promise<AdminUserDetail> {
  const entitlements = await cloudflareAdminDirectoryEntitlements([user.id]);
  const entry = entitlements.get(user.id);
  if (!entry?.mirrored) return { ...user, d1MirrorMissing: true };
  return { ...user, plan: entry.tier, accessSource: entry.source, d1MirrorMissing: false };
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
