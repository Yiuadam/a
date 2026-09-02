"use client";

import type { ReactNode } from "react";
import Maintenance from "@/components/Maintenance";
import { useRoutePath } from "@/lib/hooks";

/*
  Keep the recovery path outside the learner-facing maintenance gate.

  The maintenance flag is still compiled into the Worker, so every public page
  closes consistently. The pathname only decides whether this request is the
  owner's recovery route: /account must remain available so the owner can sign
  in, and /admin must remain available so the site can be reopened. Both areas
  keep their normal server-side authorization checks.
*/
export default function MaintenanceGate({
  closed,
  children,
}: {
  closed: boolean;
  children: ReactNode;
}) {
  /* The prefix arms below already absorbed the iOS export's trailing slash, so
     the recovery route was never actually shut behind the closed sign. It reads
     the route through the same normaliser regardless: "the exact route, or
     something under it" should hold because that is what it says, not because
     one arm happens to catch what the other misses. See routePath in
     lib/platform.ts. */
  const pathname = useRoutePath();
  const ownerRoute =
    pathname === "/account" ||
    pathname.startsWith("/account/") ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/");

  return closed && !ownerRoute ? <Maintenance /> : children;
}
