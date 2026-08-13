export type HomeOrganizationRole = "student" | "teacher" | "manager" | "owner";

export interface HomeOrganizationShortcut {
  id: string;
  name: string;
  role: HomeOrganizationRole;
  memberCount: number | null;
  studentCount: number | null;
}

const ORGANIZATION_ROLES = new Set<HomeOrganizationRole>([
  "student",
  "teacher",
  "manager",
  "owner",
]);

function nullableCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function organizationShortcut(value: unknown): HomeOrganizationShortcut | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    id?: unknown;
    name?: unknown;
    role?: unknown;
    memberCount?: unknown;
    studentCount?: unknown;
  };
  if (
    typeof candidate.id !== "string"
    || candidate.id.length === 0
    || typeof candidate.name !== "string"
    || candidate.name.trim().length === 0
    || !ORGANIZATION_ROLES.has(candidate.role as HomeOrganizationRole)
  ) return null;
  return {
    id: candidate.id,
    name: candidate.name.trim(),
    role: candidate.role as HomeOrganizationRole,
    memberCount: nullableCount(candidate.memberCount),
    studentCount: nullableCount(candidate.studentCount),
  };
}

/** Validate the deliberately small response returned to the homepage. */
export function homeOrganizationShortcutFromResponse(
  value: unknown,
): HomeOrganizationShortcut | null {
  if (!value || typeof value !== "object") return null;
  return organizationShortcut((value as { organization?: unknown }).organization);
}

/**
 * Pick the user's current active organisation from the existing portal
 * response. This deliberately accepts `unknown`: the homepage is reading a
 * network response and must not turn a malformed or stale payload into a link.
 */
export function homeOrganizationShortcutFromPortal(
  value: unknown,
): HomeOrganizationShortcut | null {
  if (!value || typeof value !== "object") return null;
  const portal = value as { activeOrganizationId?: unknown; memberships?: unknown };
  if (!Array.isArray(portal.memberships)) return null;

  const activeId = typeof portal.activeOrganizationId === "string"
    ? portal.activeOrganizationId
    : null;
  const activeMemberships = portal.memberships.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const membership = candidate as {
      status?: unknown;
      role?: unknown;
      organization?: unknown;
    };
    if (membership.status !== "active" || !ORGANIZATION_ROLES.has(membership.role as HomeOrganizationRole)) {
      return [];
    }
    if (!membership.organization || typeof membership.organization !== "object") return [];
    const organization = membership.organization as {
      id?: unknown;
      name?: unknown;
      status?: unknown;
      memberCount?: unknown;
      studentCount?: unknown;
    };
    if (
      organization.status !== "active"
      || typeof organization.id !== "string"
      || organization.id.length === 0
      || typeof organization.name !== "string"
      || organization.name.trim().length === 0
    ) return [];
    const shortcut = organizationShortcut({
      id: organization.id,
      name: organization.name,
      role: membership.role,
      memberCount: organization.memberCount,
      studentCount: organization.studentCount,
    });
    return shortcut ? [shortcut] : [];
  });

  return activeMemberships.find((membership) => membership.id === activeId)
    ?? activeMemberships[0]
    ?? null;
}
