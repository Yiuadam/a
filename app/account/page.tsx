import type { Metadata } from "next";
import AccountPanel from "@/components/AccountPanel";

/*
  A server component wrapping a client one, for the same reason app/privacy
  is a server component: `export const metadata` is only legal here. All the
  behaviour lives in components/AccountPanel.tsx.
*/

export const metadata: Metadata = {
  title: "Your account — BandUp",
  description:
    "Sign in with Google or Apple to carry your study plan between devices. An account is optional — practice tests, drills and your plan work without one.",
};

export default function AccountPage() {
  return <AccountPanel />;
}
