import { adminEmails } from "@/lib/auth/env";

export interface EffectiveAccessFields {
  email?: string | null;
  plan: string;
  access_source?: string | null;
  accessSource?: string | null;
}

function ownerAddresses(): Set<string> {
  return new Set(adminEmails());
}

function isConfiguredOwner(email: string | null | undefined, owners: ReadonlySet<string>): boolean {
  return typeof email === "string" && owners.has(email.trim().toLowerCase());
}

/**
 * ADMIN_EMAILS is an entitlement source that PostgreSQL cannot see. Apply it
 * once to an already-paged result rather than resolving every account through
 * another server/database round trip.
 */
export function applyOwnerEffectiveAccess<T extends EffectiveAccessFields>(rows: T[]): T[] {
  const owners = ownerAddresses();
  if (owners.size === 0) return rows;
  return rows.map((row) => {
    if (!isConfiguredOwner(row.email, owners)) return row;
    const next = { ...row, plan: "admin" };
    if (Object.prototype.hasOwnProperty.call(row, "access_source")) next.access_source = "role";
    if (Object.prototype.hasOwnProperty.call(row, "accessSource")) next.accessSource = "role";
    return next;
  });
}

export function applyOwnerEffectiveAccessToDetail<T extends EffectiveAccessFields>(row: T): T {
  return applyOwnerEffectiveAccess([row])[0];
}
