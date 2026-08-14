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
  /*
    Local account credentials intentionally do not live in the repository. A
    visual menu preview lets us review this layout without pretending that a
    real person is signed in or weakening the production account gate. The
    server decides this before the client is rendered, and it is impossible to
    enable outside `next dev` — so outside `next dev`, `searchParams` is never
    read at all. Reading it unconditionally would still be correct at
    runtime, since the preview only ever resolves true in exactly the one
    environment that never runs a static export, but it would also mark this
    route as needing request-time data, which `output: export` (the iOS
    build) has no server to provide. Skipping the read for every build keeps
    the route static everywhere it is actually built statically.
  */
  const localMenuPreview = process.env.NODE_ENV === "development" && (await searchParams).preview === "menu";

  return <AccountPanel localMenuPreview={localMenuPreview} />;
}
