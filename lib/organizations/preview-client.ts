export const ORGANIZATION_PREVIEW_HEADER = "x-bandup-organization-preview-role";

export type OrganizationLivePreviewRole =
  | "manager"
  | "teacher"
  | "student"
  | "admin"
  | "individual";

export function parseOrganizationLivePreviewRole(
  value: unknown,
): OrganizationLivePreviewRole | null {
  return value === "manager"
    || value === "teacher"
    || value === "student"
    || value === "admin"
    || value === "individual"
    ? value
    : null;
}

export function organizationPreviewRequestHeaders(
  role: OrganizationLivePreviewRole | null | undefined,
): Record<string, string> {
  return role ? { [ORGANIZATION_PREVIEW_HEADER]: role } : {};
}
