"use client";

import StatCard from "@/components/admin/StatCard";
import AdminOverviewCharts, {
  type AdminOverviewChartOption,
} from "@/components/admin/AdminOverviewCharts";
import AdminTrendChart from "@/components/admin/AdminTrendChart";
import FinanceTrendChart from "@/components/admin/FinanceTrendChart";
import ConsoleShell, { CONSOLE_NAV, NotFound } from "@/components/admin/ConsoleShell";
import { ConfigList, SiteSwitch } from "@/components/admin/ConsoleParts";
import { HubMenu, type HubItem } from "@/components/HubMenu";
import { exactMoneyMajor, formatExactMoney } from "@/lib/admin/finance-format";
import { estimatedHkdContribution } from "@/lib/admin/finance-view";
import { useFinance } from "@/lib/admin/useFinance";
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
  const { phase: financePhase, finance } = useFinance();

  if (phase === "loading") {
    return <p className="px-5 py-6 text-sm text-slate-500">Checking…</p>;
  }

  if (phase === "denied" || !state) {
    return <NotFound mayNeedSignIn={account.phase === "ready" && !account.signedIn} />;
  }

  /*
    Two ways to have no billing figures, and they send the owner to different
    places: no Stripe key on this Worker, or a key that is there and a call
    that failed. One message for both had them checking the network when
    Stripe had never been configured on the deployment at all.
  */
  const noBilling = stats && !stats.billing;
  const stripeMissing = noBilling && stats.stripeConfigured === false;
  const billingUnavailable = noBilling
    ? stripeMissing
      ? "No Stripe key on this Worker. See DEPLOY.md."
      : "Stripe is configured but could not be reached."
    : undefined;
  const failing = checks?.filter((c) => !c.ok).length ?? 0;
  const financeCurrencies = finance?.stripe?.currencies ?? [];
  const financePrimary = financeCurrencies.length === 1 ? financeCurrencies[0] : null;
  const exactContribution = finance?.contribution?.period ?? null;
  const estimatedContribution = !exactContribution && financePrimary && finance?.anthropic
    ? estimatedHkdContribution(financePrimary, finance.anthropic, "period")
    : null;
  const contributionMoney = exactContribution?.contribution ?? estimatedContribution?.total ?? null;
  const contributionPoints = finance?.contribution?.daily.map((row) => ({
    day: row.day,
    value: exactMoneyMajor(row.contribution),
  })) ?? estimatedContribution?.daily ?? [];
  const overviewCharts: AdminOverviewChartOption[] = [
    {
      id: "signups",
      label: "New accounts",
      description: "Daily registered accounts.",
      content:
        stats?.signups && stats.signups.length > 0 ? (
          <AdminTrendChart kind="signups" rows={stats.signups} days={stats.days} compact />
        ) : null,
    },
    {
      id: "usage",
      label: "AI requests",
      description: "Daily served and refused requests.",
      content:
        stats?.usage && stats.usage.length > 0 ? (
          <AdminTrendChart kind="usage" rows={stats.usage} days={stats.days} compact />
        ) : null,
    },
    {
      id: "net-receipts",
      label: "Net receipts",
      description: "Customer receipts after Stripe deductions.",
      content: financePrimary ? (
        <FinanceTrendChart
          title="Net customer receipts"
          summary={`${formatExactMoney(financePrimary.period.net)} · ${finance?.period.days ?? 30} days`}
          label="Net receipts"
          currency={financePrimary.currency}
          points={financePrimary.daily.map((row) => ({ day: row.day, value: exactMoneyMajor(row.operatingNet) }))}
          compact
        />
      ) : null,
    },
    {
      id: "contribution",
      label: "Contribution after AI",
      description: "Net receipts minus billed Anthropic cost.",
      content: contributionMoney && contributionPoints.length > 0 ? (
        <FinanceTrendChart
          title={exactContribution ? "Contribution after AI" : "Estimated contribution after AI"}
          summary={`${formatExactMoney(contributionMoney)} · ${finance?.period.days ?? 30} days`}
          label="Contribution"
          currency={contributionMoney.currency}
          points={contributionPoints}
          compact
          tone={exactMoneyMajor(contributionMoney) >= 0 ? "positive" : "negative"}
        />
      ) : null,
    },
  ];

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
      /*
         What learners can see, not what the owner decided — and "Closing…"
         while the two disagree, because a deployment takes about two minutes
         and a row that read "Closed" during them would be the one lie a
         console must not tell.
      */
      n.href === "/admin/site"
        ? state.closed !== state.closedByDeploy
          ? state.closed
            ? "Closing…"
            : "Opening…"
          : state.closedByDeploy
            ? "Closed"
            : "Open"
        : n.href === "/admin/config"
          ? checks === null
            ? undefined
            : failing === 0
              ? "All passing"
              : `${failing} to fix`
          : n.href === "/admin/finance"
            ? financePrimary
              ? formatExactMoney(financePrimary.period.net)
              : undefined
          : undefined,
    tone:
      (n.href === "/admin/site" && (state.closed || state.closedByDeploy)) ||
      (n.href === "/admin/config" && failing > 0)
        ? "warn"
        : "plain",
  }));

  return (
    <ConsoleShell title="Overview" lead="Yours alone. Nobody else can reach this page." compact>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
          hint={stats?.billing ? "Active subscriptions, from Stripe" : undefined}
          unavailable={billingUnavailable}
          icon={<Dot />}
        />
        <StatCard
          label={`Net receipts, ${finance?.period.days ?? 30} days`}
          value={financeCurrencies.length > 0 ? financeCurrencies.map((row) => formatExactMoney(row.period.net)).join(" · ") : "—"}
          hint={financeCurrencies.length > 0 ? "After Stripe fees, refunds and disputes" : undefined}
          unavailable={financePhase === "ready" && financeCurrencies.length === 0 ? "Stripe receipt data is unavailable." : undefined}
          icon={<Dot />}
        />
        <StatCard
          label={`AI token cost, ${finance?.period.days ?? 30} days`}
          value={finance?.anthropic ? formatExactMoney(finance.anthropic.period.tokenCost) : "—"}
          unavailable={financePhase === "ready" && !finance?.anthropic ? "Add an Anthropic Admin API key to read billed token cost." : undefined}
          icon={<Dot />}
        />
      </div>

      {/* Narrow: the rest of the console as a menu. */}
      <div className="mt-3 lg:hidden">
        <HubMenu items={menu} />
      </div>

      {/* Wide: the rest of the console, in place. */}
      <div className="mt-3 hidden space-y-3 lg:block">
        <AdminOverviewCharts options={overviewCharts} />
        <div className="grid gap-3 lg:grid-cols-2">
          <SiteSwitch
            state={state}
            busy={busy}
            error={error}
            onToggle={() => void toggle()}
            compact
          />
          <ConfigList checks={checks} compact />
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
