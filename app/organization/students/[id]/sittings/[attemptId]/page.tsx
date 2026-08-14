import type { Metadata } from "next";
import OrganizationSittingReview from "@/components/organization/OrganizationSittingReview";
import { organizationPreviewRole } from "@/lib/organizations/preview-auth";
import { managerStudentHistoryPreview } from "@/lib/organizations/preview";

export const metadata: Metadata = {
  title: "Student sitting — BandUp",
  robots: { index: false, follow: false },
};

export default async function OrganizationSittingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; attemptId: string }>;
  searchParams: Promise<{
    preview?: string | string[];
    organization?: string | string[];
    focus?: string | string[];
    from?: string | string[];
  }>;
}) {
  const { id, attemptId } = await params;
  const query = await searchParams;
  const preview = query.preview;
  const organizationId = typeof query.organization === "string" ? query.organization : null;
  const notificationFocus = query.focus === "assignment-completed";
  const fromAssignmentDirectory = query.from === "assignment-directory";
  const isolatedPreview = process.env.ORGANIZATION_UI_PREVIEW === "1";
  const previewAllowed = process.env.NODE_ENV === "development" || isolatedPreview;
  const requestedRole = typeof preview === "string" ? organizationPreviewRole(preview) : null;
  if (isolatedPreview) {
    return (
      <OrganizationSittingReview
        studentId={id}
        attemptId={attemptId}
        organizationId={organizationId}
        notificationFocus={notificationFocus}
        fromAssignmentDirectory={fromAssignmentDirectory}
        previewRole={requestedRole ?? "manager"}
      />
    );
  }
  const previewHistory = previewAllowed && preview === "manager"
    ? managerStudentHistoryPreview(id)
    : null;
  return (
    <OrganizationSittingReview
      studentId={id}
      attemptId={attemptId}
      organizationId={organizationId}
      notificationFocus={notificationFocus}
      fromAssignmentDirectory={fromAssignmentDirectory}
      previewHistory={previewHistory}
    />
  );
}
