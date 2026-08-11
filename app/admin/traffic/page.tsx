"use client";

import ConsoleShell, { NotFound } from "@/components/admin/ConsoleShell";
import { FullCharts } from "@/components/admin/ConsoleParts";
import { useTier } from "@/lib/billing/useTier";
import { useConsole } from "@/lib/admin/useConsole";

/*
  Thirty days of signups and thirty of AI requests, on a screen of their own.

  On a wide console these sit under the numbers; here they are the page. Which
  is the better place for them on a phone regardless of height — a chart the
  width of a screen is readable, and the same chart squeezed above a switch and
  a checklist is a smudge.
*/

export default function TrafficScreen() {
  const account = useTier();
  const { phase, stats } = useConsole();

  if (phase === "loading") {
    return <p className="px-5 py-6 text-sm text-slate-500">Checking…</p>;
  }
  if (phase === "denied") {
    return <NotFound mayNeedSignIn={account.phase === "ready" && !account.signedIn} />;
  }

  return (
    <ConsoleShell
      title="Signups and usage"
      lead="The last thirty days."
      back={{ href: "/admin", label: "Overview" }}
    >
      <FullCharts stats={stats} />
    </ConsoleShell>
  );
}
