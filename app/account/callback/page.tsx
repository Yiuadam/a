import type { Metadata } from "next";
import AccountCallback from "@/components/AccountCallback";

export const metadata: Metadata = {
  title: "Signing in — BandUp",
  /*
    Nothing here should ever appear in a search result: the page exists only as
    a redirect target and its URL carries a session fragment while it is open.
  */
  robots: { index: false, follow: false },
};

export default function AccountCallbackPage() {
  return <AccountCallback />;
}
