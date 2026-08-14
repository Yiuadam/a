import type { Metadata } from "next";
import NotificationInbox from "@/components/account/NotificationInbox";
import { IS_MOBILE_BUILD } from "@/lib/platform";
import { organizationPreviewRole } from "@/lib/organizations/preview-auth";
import type { OrganizationLivePreviewRole } from "@/lib/organizations/preview-client";

export const metadata: Metadata = {
  title: "Notifications — BandUp",
  description: "Your BandUp notifications.",
};

function NotificationsScreen({ previewRole }: { previewRole: OrganizationLivePreviewRole | null }) {
  return (
    <div className="px-2 py-3 sm:px-4 sm:py-6">
      <header className="mx-auto mb-2 max-w-5xl px-0.5 sm:mb-3">
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Notifications</h1>
      </header>
      <NotificationInbox previewRole={previewRole} />
    </div>
  );
}

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ preview?: string | string[] }>;
}) {
  /*
    The iOS bundle is `output: export` and has no server to await
    `searchParams` on. It also has no use for the value once read: the
    isolated-preview role this resolves only ever comes from the exact-host
    preview Worker, a website-only deployment that a shipped app is never
    running inside of, so the branch below would resolve to null there
    regardless. IS_MOBILE_BUILD is a build-time constant, so this returns
    before the promise is ever touched and the route stays static.
  */
  if (IS_MOBILE_BUILD) return <NotificationsScreen previewRole={null} />;

  const rawPreview = (await searchParams).preview;
  const requestedRole = typeof rawPreview === "string" ? organizationPreviewRole(rawPreview) : null;
  // Synthetic identities exist only in the exact-host isolated preview Worker.
  // Production ignores both the query and its corresponding request header.
  const previewRole = process.env.ORGANIZATION_UI_PREVIEW === "1"
    ? requestedRole ?? "manager"
    : null;

  return <NotificationsScreen previewRole={previewRole} />;
}
