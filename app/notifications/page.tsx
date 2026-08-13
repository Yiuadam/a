import type { Metadata } from "next";
import NotificationInbox from "@/components/account/NotificationInbox";
import { organizationPreviewRole } from "@/lib/organizations/preview-auth";

export const metadata: Metadata = {
  title: "Notifications — BandUp",
  description: "Your BandUp notifications.",
};

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ preview?: string | string[] }>;
}) {
  const rawPreview = (await searchParams).preview;
  const requestedRole = typeof rawPreview === "string" ? organizationPreviewRole(rawPreview) : null;
  // Synthetic identities exist only in the exact-host isolated preview Worker.
  // Production ignores both the query and its corresponding request header.
  const previewRole = process.env.ORGANIZATION_UI_PREVIEW === "1"
    ? requestedRole ?? "manager"
    : null;

  return (
    <div className="px-2 py-3 sm:px-4 sm:py-6">
      <header className="mx-auto mb-2 max-w-5xl px-0.5 sm:mb-3">
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Notifications</h1>
      </header>
      <NotificationInbox previewRole={previewRole} />
    </div>
  );
}
