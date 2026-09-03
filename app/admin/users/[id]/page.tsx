"use client";

import { useParams } from "next/navigation";
import AdminUserHistoryPage from "@/components/admin/UserHistoryPage";

/*
  The website's path-based route. The screen itself lives in
  components/admin/UserHistoryPage.tsx, because the app reaches the same screen
  through a query string instead — see lib/admin/user-links.ts.
*/
export default function AdminUserDetailRoute() {
  const { id } = useParams<{ id: string }>();
  return <AdminUserHistoryPage userId={id} />;
}
