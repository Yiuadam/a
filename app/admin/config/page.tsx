"use client";

import ConsoleShell, { NotFound } from "@/components/admin/ConsoleShell";
import { ConfigList } from "@/components/admin/ConsoleParts";
import { useTier } from "@/lib/billing/useTier";
import { useConsole } from "@/lib/admin/useConsole";

/*
  What is wired up, and what isn't.

  The list shows only what is failing, with the rest collapsed to a count — a
  screen of green ticks is a screen nobody reads, and the one red line in the
  middle of it is what this exists to show.
*/

export default function ConfigScreen() {
  const account = useTier();
  const { phase, checks } = useConsole();

  if (phase === "loading") {
    return <p className="px-5 py-6 text-sm text-slate-500">Checking…</p>;
  }
  if (phase === "denied") {
    return <NotFound mayNeedSignIn={account.phase === "ready" && !account.signedIn} />;
  }

  return (
    <ConsoleShell
      title="Configuration"
      lead="The variables and database functions the app depends on."
      back={{ href: "/admin", label: "Overview" }}
    >
      <ConfigList checks={checks} />
    </ConsoleShell>
  );
}
