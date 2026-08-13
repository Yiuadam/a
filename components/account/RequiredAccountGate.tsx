"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { accountUsernameReady } from "@/lib/auth/account-identity";
import LoadingIndicator from "@/components/LoadingIndicator";
import { useAccountProfile } from "./AccountProfileProvider";

const ALWAYS_REACHABLE = [
  "/account/onboarding",
  "/account/callback",
  "/account/close",
  "/privacy",
  "/terms",
];

/** Required setup is a registration step, not a permission or paid-plan gate. */
export default function RequiredAccountGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { phase, profile } = useAccountProfile();
  const allowed = ALWAYS_REACHABLE.some((path) => pathname === path || pathname.startsWith(`${path}/`));
  const waiting = phase === "loading" && !allowed;
  const usernameReady = accountUsernameReady(profile)
    && profile?.organizationUsernameReady !== false;
  const blocked = phase === "ready" && !usernameReady && !allowed;

  useEffect(() => {
    if (!blocked) return;
    const returnTo = `${pathname}${window.location.search}`;
    router.replace(`/account/onboarding?returnTo=${encodeURIComponent(returnTo)}`);
  }, [blocked, pathname, router]);

  if (blocked || waiting) {
    return (
      <main className="grid min-h-[50dvh] place-items-center px-5 py-10" aria-live="polite">
        <p className="text-sm text-slate-500"><LoadingIndicator label={blocked ? "Opening account setup…" : "Checking account setup…"} /></p>
      </main>
    );
  }
  return children;
}
