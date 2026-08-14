"use client";

import { useSearchParams } from "next/navigation";
import OrganizationPortal from "@/components/organization/OrganizationPortal";

function routeFocus(query: URLSearchParams): { kind: "teacher-feedback" | "request" | null; id: string | null } {
  const focus = query.get("focus");
  if (focus === "teacher-feedback") return { kind: focus, id: query.get("attempt") };
  if (focus === "request") return { kind: focus, id: query.get("request") };
  return { kind: null, id: null };
}

/*
  Reads the same routing state as ../page.tsx's server branch, on the client,
  for the iOS build only — see the IS_MOBILE_BUILD branch there for why.

  `preview` is deliberately not read. The isolated D1 preview and the
  localhost UI preview (see lib/organizations/preview.ts and preview-auth.ts)
  are both website-only deployment concerns: one depends on a server env var
  this static bundle never has set, the other on `next dev`, which a shipped
  app never runs inside of. previewRole is simply always null here.
*/
export default function OrganizationQueryShell() {
  const query = useSearchParams();
  const routeSection = query.get("section");
  const routeInvite = query.get("invite");
  const routeOrganizationId = query.get("organization");
  const routeAssignmentStudentId = query.get("student");
  const focus = routeFocus(query);
  const legacyInvite = routeSection === "members" && routeInvite === "people";
  const routeKey = [routeOrganizationId, routeSection, legacyInvite ? "legacy-invite" : null, routeAssignmentStudentId, focus.kind, focus.id]
    .map((value) => value ?? "")
    .join(":");

  return (
    <OrganizationPortal
      key={routeKey}
      routeOrganizationId={routeOrganizationId}
      routeSection={routeSection}
      routeAssignmentStudentId={routeAssignmentStudentId}
      routeFocusKind={focus.kind}
      routeFocusId={focus.id}
    />
  );
}
