"use client";

import { useSearchParams } from "next/navigation";
import {
  parseOrganizationLivePreviewRole,
} from "@/lib/organizations/preview-client";
import NotificationBell from "./NotificationBell";

/**
 * The production header uses the authenticated account. The isolated public
 * organization preview has no Supabase session, so it uses the selected
 * synthetic role instead. Keeping that exception here prevents a query string
 * on bandup.life from ever creating a synthetic notification identity.
 */
export default function HeaderNotificationBell({
  signedIn,
  isolatedOrganizationPreview,
}: {
  signedIn: boolean;
  isolatedOrganizationPreview: boolean;
}) {
  const search = useSearchParams();
  const previewRole = isolatedOrganizationPreview
    ? parseOrganizationLivePreviewRole(search.get("preview")) ?? "manager"
    : null;
  if (!signedIn && !previewRole) return null;
  return <NotificationBell previewRole={previewRole} />;
}
