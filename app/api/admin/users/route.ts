import { NextResponse } from "next/server";
import { accountsEnabled, isAdminEmail } from "@/lib/auth/env";
import { getSessionUser } from "@/lib/auth/session";
import { safeJsonError } from "@/lib/auth/errors";
import { rpc, supabaseConfigured } from "@/lib/auth/supabase";
import { withCors } from "@/lib/http/cors";
import { applyOwnerEffectiveAccess } from "@/lib/admin/effective-access";
import { organizationDataMode } from "@/lib/cloudflare/bindings";
import { cloudflareAdminOrganizationSeats } from "@/lib/cloudflare/admin-organization-access";

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
    const users = await rpc<AdminUserRow[]>("admin_users_page", {
      p_query: query,
      p_limit: limit,
      p_offset: (page - 1) * limit,
    });
    const effective = applyOwnerEffectiveAccess(users);
    const currentUsers = organizationDataMode() === "cloudflare"
      ? await mergeCloudflareSeatCounts(effective)
      : effective;
    return NextResponse.json({
      users: currentUsers,
      page,
      limit,
      total: Number(users[0]?.total_count ?? 0),
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

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
