import type { Metadata } from "next";
import StudentHistoryPage from "@/components/organization/StudentHistoryPage";
import { organizationPreviewRole } from "@/lib/organizations/preview-auth";
import { managerStudentHistoryPreview } from "@/lib/organizations/preview";

export const metadata: Metadata = {
  title: "Student progress — BandUp",
  robots: { index: false, follow: false },
};

export default async function OrganizationStudentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    preview?: string | string[];
    organization?: string | string[];
  }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const preview = query.preview;
  const organizationId = typeof query.organization === "string" ? query.organization : null;
  const isolatedPreview = process.env.ORGANIZATION_UI_PREVIEW === "1";
  const previewAllowed = process.env.NODE_ENV === "development" || isolatedPreview;
  const requestedRole = typeof preview === "string" ? organizationPreviewRole(preview) : null;
  if (isolatedPreview) {
    return <StudentHistoryPage studentId={id} organizationId={organizationId} previewRole={requestedRole ?? "manager"} />;
  }
  const previewHistory = previewAllowed && preview === "manager"
    ? managerStudentHistoryPreview(id)
    : null;
  return <StudentHistoryPage studentId={id} organizationId={organizationId} preview={previewHistory} />;
}
