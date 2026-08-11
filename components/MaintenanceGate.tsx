"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import Maintenance from "@/components/Maintenance";

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
  const pathname = usePathname();
  const ownerRoute =
    pathname === "/account" ||
    pathname.startsWith("/account/") ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/");

  return closed && !ownerRoute ? <Maintenance /> : children;
}
