import { NextResponse } from "next/server";
import { accountsEnabled, isAdminEmail } from "@/lib/auth/env";
import { getSessionUser } from "@/lib/auth/session";
import { safeJsonError } from "@/lib/auth/errors";
import { rpc, supabaseConfigured } from "@/lib/auth/supabase";
import { withCors } from "@/lib/http/cors";
import { applyOwnerEffectiveAccess } from "@/lib/admin/effective-access";
import { organizationDataMode } from "@/lib/cloudflare/bindings";
import { domainReadsFromCloudflare } from "@/lib/cloudflare/cutover-domains";
import { cloudflareAdminOrganizationSeats } from "@/lib/cloudflare/admin-organization-access";
import { cloudflareAdminDirectoryEntitlements } from "@/lib/cloudflare/admin-entitlement-directory";

export const dynamic = "force-dynamic";

export interface AdminUserRow {
  id: string;
  email: string | null;
  username: string | null;
  display_name: string | null;
  account_kind: string | null;
  registered_at: string;
  plan: string;
  access_source: string;
  organization_seat_count: number;
  usage_30d: number;
  total_count: number;
  /**
   * Present only when `admin_user_directory` reads from Cloudflare: true if
   * this account has an `app_users` row in D1, false if Auth knows about it
   * and the D1 mirror does not. A missing mirror row must never be presented
   * as an ordinary free-tier account — see `mergeCloudflareEntitlements`.
   */
  d1_mirror_missing?: boolean;
}

async function handleGET(req: Request) {
  if (!accountsEnabled() || !supabaseConfigured()) return safeJsonError("Not found.", 404);
  const actor = await getSessionUser(req).catch(() => null);
  if (!actor || !isAdminEmail(actor.email)) return safeJsonError("Not found.", 404);
  const url = new URL(req.url);
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
  const page = Math.max(1, Math.min(10000, Number(url.searchParams.get("page")) || 1));
  const limit = 50;
  try {
    let users = await rpc<AdminUserRow[]>("admin_users_page", {
      p_query: query,
      p_limit: limit,
      p_offset: (page - 1) * limit,
    });
    const total = Number(users[0]?.total_count ?? 0);
    if (domainReadsFromCloudflare("admin_user_directory")) {
      users = await mergeCloudflareEntitlements(users);
    }
    const effective = applyOwnerEffectiveAccess(users);
    const currentUsers = organizationDataMode() === "cloudflare"
      ? await mergeCloudflareSeatCounts(effective)
      : effective;
    return NextResponse.json({
      users: currentUsers,
      page,
      limit,
      total,
    });
  } catch {
    return safeJsonError("The user directory is unavailable right now.", 503);
  }
}

async function mergeCloudflareSeatCounts(users: AdminUserRow[]): Promise<AdminUserRow[]> {
  const seats = await cloudflareAdminOrganizationSeats(users.map((user) => user.id));
  return users.map((user) => ({
    ...user,
    organization_seat_count: seats.get(user.id)?.length ?? 0,
  }));
}

/**
 * Replaces Supabase's `resolve_entitlement`-computed plan/access source with
 * the D1 entitlement resolver's answer, per row.
 *
 * The roster itself — which accounts appear, their email, username, display
 * name, registration date — stays exactly what `admin_users_page` returned;
 * only `plan` and `access_source` are overwritten, and only for accounts
 * `cloudflareAdminDirectoryEntitlements` reports as mirrored into D1. An
 * unmirrored row keeps its Supabase-resolved plan untouched and is marked
 * `d1_mirror_missing: true` instead — never silently shown as "free", which
 * is indistinguishable from a genuinely free account with no mirror gap.
 */
async function mergeCloudflareEntitlements(users: AdminUserRow[]): Promise<AdminUserRow[]> {
  const entitlements = await cloudflareAdminDirectoryEntitlements(users.map((user) => user.id));
  return users.map((user) => {
    const entry = entitlements.get(user.id);
    if (!entry?.mirrored) return { ...user, d1_mirror_missing: true };
    return { ...user, plan: entry.tier, access_source: entry.source, d1_mirror_missing: false };
  });
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
