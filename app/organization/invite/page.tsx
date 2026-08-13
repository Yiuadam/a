import type { Metadata } from "next";
import InvitationAcceptance from "@/components/organization/InvitationAcceptance";

export const metadata: Metadata = {
  title: "Organisation invitation — BandUp",
  robots: { index: false, follow: false },
};

export default async function OrganizationInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ request?: string | string[] }>;
}) {
  const request = (await searchParams).request;
  return <InvitationAcceptance requestId={typeof request === "string" ? request : null} />;
}
