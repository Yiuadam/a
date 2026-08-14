import type { Metadata } from "next";
import { Suspense } from "react";
import InvitationAcceptance from "@/components/organization/InvitationAcceptance";
import { IS_MOBILE_BUILD } from "@/lib/platform";
import InviteQueryShell from "./InviteQueryShell";

export const metadata: Metadata = {
  title: "Organisation invitation — BandUp",
  robots: { index: false, follow: false },
};

export default async function OrganizationInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ request?: string | string[] }>;
}) {
  /*
    The iOS bundle is `output: export`: no server ever runs, so a Server
    Component here cannot await `searchParams` — that request-time read is
    exactly what marks a route as needing a server, which a static export by
    definition does not have. The website keeps reading it here, server-side,
    as it already did; only the iOS build takes the client-side detour
    through ./InviteQueryShell.tsx, which reads the same query with
    useSearchParams() instead. IS_MOBILE_BUILD is a build-time constant, so
    the branch not taken is never reached and never touches the promise.
  */
  if (IS_MOBILE_BUILD) {
    return (
      <Suspense fallback={null}>
        <InviteQueryShell />
      </Suspense>
    );
  }
  const request = (await searchParams).request;
  return <InvitationAcceptance requestId={typeof request === "string" ? request : null} />;
}
