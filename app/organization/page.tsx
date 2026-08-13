import type { Metadata } from "next";
import OrganizationPortal from "@/components/organization/OrganizationPortal";
import { organizationPreviewRole as livePreviewRole } from "@/lib/organizations/preview-auth";
import { organizationRolePreview, type OrganizationPreviewRole } from "@/lib/organizations/preview";

export const metadata: Metadata = {
  title: "Organisation — BandUp",
  description: "Join and manage BandUp learning organisations, assignments and shared progress.",
};

export default async function OrganizationPage({
  searchParams,
}: {
  searchParams: Promise<{
    preview?: string | string[];
    section?: string | string[];
    focus?: string | string[];
    attempt?: string | string[];
    request?: string | string[];
    organization?: string | string[];
    student?: string | string[];
  }>;
}) {
  const query = await searchParams;
  const rawPreview = query.preview;
  const preview = typeof rawPreview === "string" ? rawPreview : null;
  const routeSection = typeof query.section === "string" ? query.section : null;
  const routeOrganizationId = typeof query.organization === "string" ? query.organization : null;
  const routeAssignmentStudentId = typeof query.student === "string" ? query.student : null;
  const routeFocusKind = query.focus === "teacher-feedback"
    ? "teacher-feedback"
    : query.focus === "request" && typeof query.request === "string"
      ? "request"
      : null;
  const routeFocusId = routeFocusKind === "teacher-feedback"
    ? (typeof query.attempt === "string" ? query.attempt : null)
    : (typeof query.request === "string" ? query.request : null);
  const routeKey = [routeOrganizationId, routeSection, routeAssignmentStudentId, routeFocusKind, routeFocusId]
    .map((value) => value ?? "")
    .join(":");
  const roles = new Set<OrganizationPreviewRole>(["manager", "teacher", "student", "former", "admin", "individual"]);
  const isolatedPreview = process.env.ORGANIZATION_UI_PREVIEW === "1";
  const previewAllowed = process.env.NODE_ENV === "development" || isolatedPreview;
  const requestedRole = roles.has(preview as OrganizationPreviewRole)
    ? preview as OrganizationPreviewRole
    : null;
  // The isolated Worker uses the real D1 command service with synthetic
  // identities. Local development keeps the read-only fixture so UI work does
  // not need a running Cloudflare binding. Production has neither path.
  const previewRole = previewAllowed ? requestedRole ?? (isolatedPreview ? "manager" : null) : null;
  if (isolatedPreview) {
    return <OrganizationPortal key={routeKey} previewRole={livePreviewRole(previewRole) ?? "manager"} routeOrganizationId={routeOrganizationId} routeSection={routeSection} routeAssignmentStudentId={routeAssignmentStudentId} routeFocusKind={routeFocusKind} routeFocusId={routeFocusId} />;
  }
  return <OrganizationPortal key={routeKey} preview={previewRole ? organizationRolePreview(previewRole) : null} routeOrganizationId={routeOrganizationId} routeSection={routeSection} routeAssignmentStudentId={routeAssignmentStudentId} routeFocusKind={routeFocusKind} routeFocusId={routeFocusId} />;
}
