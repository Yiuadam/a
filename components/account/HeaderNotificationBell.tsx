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
  /*
    Drawn whether or not anybody is signed in, at the owner's ask.

    It used to disappear entirely for a signed-out visitor, which made the
    header change shape on sign-in — the account button jumping sideways as a
    control it had never seen appeared beside it. A bell that is always in the
    same place is one fewer thing to relearn, and NotificationBell already
    knows how to be empty: it fetches nothing without a session and opens on a
    panel that says so.

    `signedIn` is still read, because the isolated organisation preview needs
    its synthetic role and that must never come from a query string on
    bandup.life.
  */
  return <NotificationBell previewRole={previewRole} signedOut={!signedIn && !previewRole} />;
}
