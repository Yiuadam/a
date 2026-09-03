"use client";

import { useParams } from "next/navigation";
import AdminSittingPage from "@/components/admin/SittingPage";

/*
  The website's path-based route. The screen lives in
  components/admin/SittingPage.tsx, because the app reaches it through a query
  string instead — see lib/admin/user-links.ts.
*/
export default function AdminSittingRoute() {
  const { id, sitting } = useParams<{ id: string; sitting: string }>();
  return <AdminSittingPage userId={id} sittingKey={sitting} />;
}
