"use client";

import { useEffect } from "react";
import { markVisited } from "@/lib/store";

/**
 * Retires a dashboard "New" label once its destination is genuinely open.
 *
 * The homepage link marks a visit immediately, while this small route marker
 * also covers direct URLs and navigation from the menu. `markVisited` is
 * idempotent, so rendering both paths never causes an extra write.
 */
export default function DashboardVisit({ destination }: { destination: string }) {
  useEffect(() => {
    markVisited(destination);
  }, [destination]);

  return null;
}
