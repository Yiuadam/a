"use client";

import StatCard from "@/components/admin/StatCard";
import ConsoleShell, { CONSOLE_NAV, NotFound } from "@/components/admin/ConsoleShell";
import { Charts, ConfigList, SiteSwitch } from "@/components/admin/ConsoleParts";
import { HubMenu, type HubItem } from "@/components/HubMenu";
import { formatPrice } from "@/lib/billing/tiers";
import { useTier } from "@/lib/billing/useTier";
import { useConsole } from "@/lib/admin/useConsole";

/*
  The owner's own screen: what the site is doing, and the one control that
  changes it.

  ---------------------------------------------------------------------------
  Deliberately small

  It would be easy to make this a console — subscriber counts, revenue, usage
  graphs, a log viewer. It is four numbers, two charts, a switch and a list of
  checks because those are the questions the owner has actually needed answered
  this week: is anything misconfigured, and can I take the site down right now.
  Everything else already has a home — Stripe has the money, Supabase has the
  accounts, and duplicating either here would mean a second version of the
  truth to keep in step.

  ---------------------------------------------------------------------------
  One page on a laptop, four screens on a phone

  Not two designs. The numbers are always here; below `lg` the three panels
  under them become a menu, and each opens the same component on its own
  screen. That is the same split /account and /billing now have, for the same
  reason — a phone showing all of this at once ran 1915 pixels, of which the
  four numbers alone took six hundred.

  `lg` rather than `sm` is where it changes, because that is where the dark
  rail appears. A console with a sidebar has somewhere to navigate from; one
  without needs the page itself to be the navigation.

  Both arrangements are in the DOM and chosen by a breakpoint class. Nothing
  here is focusable twice — one is panels, the other is links to the same
  panels — so the cost is some duplicated markup on a page one person opens.

  ---------------------------------------------------------------------------
  Nothing here decides anything

  The gate is server-side (app/api/admin/*), and both routes check the session
  against ADMIN_EMAILS before acting. Editing this page in dev tools changes
  what a non-owner sees and nothing about what any route will do — the API
  answers 404 to anyone else, which is also why a non-owner who guesses this
  URL learns nothing.
*/

export default function AdminPage() {
  const account = useTier();
  const { phase, state, checks, stats, busy, error, toggle } = useConsole();

  if (phase === "loading") {
    return <p className="px-5 py-6 text-sm text-slate-500">Checking…</p>;
  }

  if (phase === "denied" || !state) {
    return <NotFound mayNeedSignIn={account.phase === "ready" && !account.signedIn} />;
  }

  const servedTotal = stats?.usage?.reduce((n, d) => n + (d.admitted ?? 0), 0) ?? null;
  const failing = checks?.filter((c) => !c.ok).length ?? 0;

  /*
    What each row is worth knowing without opening it. The site being closed is
    the one fact on this page that can be an emergency, so it is the one drawn
    in amber.
  */
  const menu: HubItem[] = CONSOLE_NAV.filter((n) => n.href !== "/admin").map((n) => ({
    href: n.href,
    title: n.title,
    detail: n.detail,
    value:
      n.href === "/admin/site"
        ? state.closed
          ? "Closed"
          : "Open"
        : n.href === "/admin/config"
          ? checks === null
            ? undefined
            : failing === 0
              ? "All passing"
              : `${failing} to fix`
          : undefined,
    tone:
      (n.href === "/admin/site" && state.closed) || (n.href === "/admin/config" && failing > 0)
        ? "warn"
        : "plain",
  }));

  return (
    <ConsoleShell title="Overview" lead="Yours alone. Nobody else can reach this page.">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard
          label="Registered accounts"
          value={stats?.users != null ? stats.users.toLocaleString() : "—"}
          unavailable={
            stats && stats.users == null ? "The stats migration may not be applied yet." : undefined
          }
          icon={<Dot />}
        />
        <StatCard
          label="Paying subscribers"
          value={stats?.billing ? stats.billing.active.toLocaleString() : "—"}
          hint={stats?.billing ? "Active and trialing, from Stripe" : undefined}
          unavailable={stats && !stats.billing ? "Stripe could not be reached." : undefined}
          icon={<Dot />}
        />
        <StatCard
          label="Monthly revenue"
          value={stats?.billing ? formatPrice(Math.round(stats.billing.mrrHkd * 100), "hkd") : "—"}
          hint={stats?.billing ? "Yearly plans divided over twelve months" : undefined}
          unavailable={stats && !stats.billing ? "Stripe could not be reached." : undefined}
          icon={<Dot />}
        />
        <StatCard
          label={`AI requests, ${stats?.days ?? 30} days`}
          value={servedTotal != null ? servedTotal.toLocaleString() : "—"}
          unavailable={
            stats && stats.usage == null ? "The stats migration may not be applied yet." : undefined
          }
          icon={<Dot />}
        />
      </div>

      {/* Narrow: the rest of the console as a menu. */}
      <div className="mt-3 lg:hidden">
        <HubMenu items={menu} />
      </div>

      {/* Wide: the rest of the console, in place. */}
      <div className="mt-4 hidden space-y-4 lg:block">
        <Charts stats={stats} />
        <div className="grid gap-4 xl:grid-cols-2">
          <SiteSwitch state={state} busy={busy} error={error} onToggle={() => void toggle()} />
          <ConfigList checks={checks} />
        </div>
      </div>
    </ConsoleShell>
  );
}

/** A neutral tile glyph. The cards are about their numbers, not their icons. */
function Dot() {
  return (
    <svg
      viewBox="0 0 20 20"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="14" height="14" rx="4" />
      <path d="M7 12.5 9.5 9l2 2.2L14 7.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
