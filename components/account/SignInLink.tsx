"use client";

import Link, { type LinkProps } from "next/link";
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";
import { rememberAuthReturnPath } from "@/lib/auth/return-path";

/*
  Every "Sign in to do X" prompt in the app sends a visitor to /account the
  same way, and every one of them deserves the same courtesy on the way
  back: land where the button was clicked, not on a generic account page
  that has to be navigated away from a second time.

  This is the one place that calls rememberAuthReturnPath — every prompt
  uses this component instead of a bare <Link href="/account"> so the rule
  cannot be forgotten at a new call site. Sign-in itself already consumes
  the remembered path (components/account/SignedOut.tsx's password form,
  GoogleSignIn.tsx, AccountCallback.tsx for Apple and recovery links); this
  is only the other half, recording where "back" means before the
  navigation away happens.

  A caller's own onClick (FreeProPoster sets an auto-continue flag before
  sending a guest to sign up) runs after the path is remembered, not
  instead of it — the two are unrelated concerns and neither should be
  able to silently drop the other.
*/
export default function SignInLink({
  href = "/account",
  prefetch,
  children,
  onClick,
  ...rest
}: {
  href?: LinkProps["href"];
  prefetch?: LinkProps["prefetch"];
  children: ReactNode;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick">) {
  return (
    <Link
      href={href}
      prefetch={prefetch}
      onClick={(event) => {
        if (typeof window !== "undefined") {
          rememberAuthReturnPath(
            `${window.location.pathname}${window.location.search}${window.location.hash}`,
          );
        }
        onClick?.(event);
      }}
      {...rest}
    >
      {children}
    </Link>
  );
}
