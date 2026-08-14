"use client";

import ConsoleShell, { NotFound } from "@/components/admin/ConsoleShell";
import LoadingIndicator from "@/components/LoadingIndicator";
import { SiteSwitch } from "@/components/admin/ConsoleParts";
import { useTier } from "@/lib/billing/useTier";
import { useConsole } from "@/lib/admin/useConsole";

/*
  The one control on the console that changes what a learner sees.

  It gets a screen to itself rather than a corner of a dashboard, and that is
  the right weight for it: this button takes the whole site down. Nothing else
  is on the screen to be aimed at by mistake.
*/

export default function SiteScreen() {
  const account = useTier();
  const { phase, state, busy, error, toggle } = useConsole();

  if (phase === "loading") {
    return <p className="px-5 py-6 text-sm text-slate-500"><LoadingIndicator label="Checking…" /></p>;
  }
  if (phase === "denied" || !state) {
    return <NotFound mayNeedSignIn={account.phase === "ready" && !account.signedIn} />;
  }

  return (
    <ConsoleShell
      title="Site status"
      lead="Whether learners see the app or the upgrade notice."
      back={{ href: "/admin", label: "Overview" }}
    >
      <SiteSwitch state={state} busy={busy} error={error} onToggle={() => void toggle()} />
    </ConsoleShell>
  );
}
