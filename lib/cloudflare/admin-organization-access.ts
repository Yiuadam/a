import { assertServerOnly } from "@/lib/auth/server-only";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";

const MODULE = "lib/cloudflare/admin-organization-access.ts";
const MAX_USERS = 100;

export interface AdminOrganizationSeat {
  organizationId: string;
  organizationName: string;
  status: "reserved" | "active";
  endsAt: string | null;
}

interface SeatRow {
  user_id: string;
  organization_id: string;
  organization_name: string;
  status: AdminOrganizationSeat["status"];
  ends_at: string | null;
}

function distinctUserIds(userIds: readonly string[]): string[] {
  return [...new Set(userIds.filter((value) => /^[0-9a-f-]{36}$/i.test(value)))].slice(0, MAX_USERS);
}

/**
 * Reads organisation-seat access from the active organisation authority.
 * Admin APIs deliberately fail closed if this read is unavailable rather than
 * displaying the older Supabase organisation copy as current data.
 */
export async function cloudflareAdminOrganizationSeats(
  userIds: readonly string[],
  providedBindings?: BandUpCloudflareBindings,
): Promise<Map<string, AdminOrganizationSeat[]>> {
  assertServerOnly(MODULE);
  const ids = distinctUserIds(userIds);
  const result = new Map<string, AdminOrganizationSeat[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return result;

  const { db } = providedBindings ?? await requireBandUpCloudflareBindings();
  const placeholders = ids.map(() => "?").join(", ");
  const current = new Date().toISOString();
  const query = await db.prepare(`
    SELECT allocation.user_id,
           allocation.organization_id,
           organization.name AS organization_name,
           allocation.status,
           CASE
             WHEN allocation.ends_at IS NULL THEN pool.ends_at
             WHEN pool.ends_at IS NULL THEN allocation.ends_at
             WHEN allocation.ends_at <= pool.ends_at THEN allocation.ends_at
             ELSE pool.ends_at
           END AS ends_at
      FROM organization_seat_allocations allocation
      JOIN organization_seat_pools pool
        ON pool.id = allocation.seat_pool_id
       AND pool.organization_id = allocation.organization_id
      JOIN organizations organization ON organization.id = allocation.organization_id
     WHERE allocation.user_id IN (${placeholders})
       AND allocation.status IN ('reserved', 'active')
       AND allocation.starts_at <= ?
       AND (allocation.ends_at IS NULL OR allocation.ends_at > ?)
       AND pool.status = 'active'
       AND (pool.starts_at IS NULL OR pool.starts_at <= ?)
       AND (pool.ends_at IS NULL OR pool.ends_at > ?)
     ORDER BY allocation.user_id, organization.name, allocation.organization_id
  `).bind(...ids, current, current, current, current).all<SeatRow>();

  for (const row of query.results) {
    result.get(row.user_id)?.push({
      organizationId: row.organization_id,
      organizationName: row.organization_name,
      status: row.status,
      endsAt: row.ends_at,
    });
  }
  return result;
}
