"use client";

import { useSearchParams } from "next/navigation";
import InvitationAcceptance from "@/components/organization/InvitationAcceptance";

/*
  Reads the invitation request id from the query string on the client. Kept
  out of the server page (see ./page.tsx) so the route stays statically
  exportable — a server component that awaits `searchParams` cannot be, and
  `output: export` (the iOS build) has no server to fall back to.
*/
export default function InviteQueryShell() {
  const requestId = useSearchParams().get("request");
  return <InvitationAcceptance requestId={requestId} />;
}
