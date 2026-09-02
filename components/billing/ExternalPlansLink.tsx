"use client";

import type { ReactNode } from "react";
import { openPlansExternally } from "@/lib/billing/storefront";

/*
  A link out of the iOS app to the website's plan pages, for the storefronts
  where that is allowed — see lib/billing/storefront.ts for which, and why it
  is not all of them.

  A real `<a>` with a real `href`, rather than a button styled to look like
  one. It costs nothing and it buys three things: a screen reader announces it
  as a link, a long press offers to copy the address, and anyone reading the
  bundle can see where it goes. The click is still handled here, because the
  default would navigate this web view to the website and leave the learner
  outside the app with no way back.
*/
export default function ExternalPlansLink({
  url,
  className,
  children,
}: {
  url: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={url}
      className={className}
      onClick={(event) => {
        event.preventDefault();
        openPlansExternally(url);
      }}
    >
      {children}
    </a>
  );
}
