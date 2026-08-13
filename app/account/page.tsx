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

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ preview?: string }>;
}) {
  const { preview } = await searchParams;

  /*
    Local account credentials intentionally do not live in the repository. A
    visual menu preview lets us review this layout without pretending that a
    real person is signed in or weakening the production account gate. The
    server decides this before the client is rendered, and it is impossible to
    enable outside `next dev`.
  */
  const localMenuPreview = process.env.NODE_ENV === "development" && preview === "menu";

  return <AccountPanel localMenuPreview={localMenuPreview} />;
}
