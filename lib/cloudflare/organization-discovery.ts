import type { SessionUser } from "@/lib/auth/session";
import { normaliseUsername } from "@/lib/auth/usernames";
import type {
  OrganizationDiscoveryResponse,
  OrganizationNameSearchResult,
  OrganizationUserSearchResult,
} from "@/lib/organizations/types";
import { requireBandUpCloudflareBindings } from "./bindings";

type Db = Env["BANDUP_DB"];

async function actorRole(db: Db, organizationId: string, actorId: string): Promise<string | null> {
  const row = await db.prepare(`
    SELECT m.role
      FROM organization_memberships m
      JOIN organizations o ON o.id = m.organization_id
     WHERE m.organization_id = ? AND m.user_id = ?
       AND m.status = 'active' AND o.status = 'active'
  `).bind(organizationId, actorId).first<{ role: string }>();
  return row?.role ?? null;
}

function organizationQuery(raw: string): string | null {
  const value = raw.trim().replace(/\s+/g, " ");
  return value.length >= 2 && value.length <= 80 ? value : null;
}

export async function cloudflareOrganizationDiscovery(
  user: SessionUser,
  platformAdmin: boolean,
  kind: "user" | "organization",
  query: string,
  organizationId?: string | null,
): Promise<OrganizationDiscoveryResponse> {
  const { db } = await requireBandUpCloudflareBindings();

  if (kind === "user") {
    const username = normaliseUsername(query);
    if (!username || !organizationId) return { kind, results: [] };
    const role = await actorRole(db, organizationId, user.id);
    if (!platformAdmin && role !== "teacher" && role !== "manager" && role !== "owner") {
      return { kind, results: [] };
    }
    const row = await db.prepare(`
      SELECT u.id AS userId, n.username, p.display_name AS displayName
        FROM usernames n
        JOIN app_users u ON u.id = n.user_id AND u.deleted_at IS NULL
        LEFT JOIN learner_profiles p ON p.user_id = u.id
       WHERE n.username = ? COLLATE NOCASE
         AND NOT EXISTS (
           SELECT 1 FROM organization_memberships m
            WHERE m.organization_id = ? AND m.user_id = u.id
              AND m.status <> 'removed'
         )
       LIMIT 1
    `).bind(username, organizationId).first<OrganizationUserSearchResult>();
    return { kind, results: row ? [row] : [] };
  }

  const name = organizationQuery(query);
  if (!name) return { kind, results: [] };
  const escaped = name.toLowerCase().replace(/[\\%_]/g, "\\$&");
  const result = await db.prepare(`
    SELECT o.id AS organizationId, o.name
      FROM organizations o
     WHERE o.status = 'active'
       AND lower(o.name) LIKE '%' || ? || '%' ESCAPE '\\'
       AND NOT EXISTS (
         SELECT 1 FROM organization_memberships m
          WHERE m.organization_id = o.id AND m.user_id = ?
            AND m.status <> 'removed'
       )
     ORDER BY CASE WHEN lower(o.name) = lower(?) THEN 0 ELSE 1 END,
              length(o.name), lower(o.name)
     LIMIT 8
  `).bind(escaped, user.id, name).all<OrganizationNameSearchResult>();
  return { kind, results: result.results };
}
