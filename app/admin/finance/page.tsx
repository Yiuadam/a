"use client";

import ConsoleShell, { NotFound } from "@/components/admin/ConsoleShell";
import FinanceTrendChart from "@/components/admin/FinanceTrendChart";
import { exactMoneyMajor, formatExactMoney } from "@/lib/admin/finance-format";
import type {
  AnthropicCostSnapshot,
  ExactMoney,
  HkdFinanceTotals,
  HkdFxSnapshot,
} from "@/lib/admin/finance-types";
import { grossCustomerPayments } from "@/lib/admin/finance-view";
import { useFinance } from "@/lib/admin/useFinance";
import { useTier } from "@/lib/billing/useTier";
import { useState } from "react";

type FinanceRange = "lifetime" | "period";
type FinanceData = NonNullable<ReturnType<typeof useFinance>["finance"]>;

export default function FinancePage() {
  const account = useTier();
  const { phase, finance } = useFinance();

  if (phase === "loading") return <p className="px-5 py-6 text-sm text-slate-500">Reading money and AI cost data…</p>;
  if (phase === "denied") return <NotFound mayNeedSignIn={account.phase === "ready" && !account.signedIn} />;

  return (
    <ConsoleShell
      title="Money & AI cost"
      lead="Customer payments, Stripe fees and AI costs, with every source shown."
      back={{ href: "/admin", label: "Overview" }}
    >
      {phase === "error" || !finance ? (
        <Unavailable text="The financial report could not be loaded just now." />
      ) : (
        <FinanceReport finance={finance} />
      )}
    </ConsoleShell>
  );
}

function FinanceReport({ finance }: { finance: FinanceData }) {
  const [range, setRange] = useState<FinanceRange>("period");
  const currencies = finance.stripe?.currencies ?? [];
  const primary = currencies.length === 1 ? currencies[0] : null;
  const anthropic = finance.anthropic;
  const exactContribution = finance.contribution;
  const hkdEstimate = finance.hkdEstimate;
  const contribution = exactContribution?.[range].contribution ?? null;
  const gross = currencies.map((row) => grossCustomerPayments(row, range));
  const fees = currencies.map((row) => row[range].fees);
  const received = currencies.map((row) => row[range].net);
  const aiCost = anthropic ? [anthropic[range].cost] : [];
  const rangeDescription = range === "lifetime"
    ? `Provider activity since ${date(finance.lifetimeStartingAt)}.`
    : `${date(finance.period.startingAt)} to ${date(finance.period.endingAt)}, in UTC.`;
  const rangeName = range === "lifetime" ? "Lifetime" : `Last ${finance.period.days} days`;
  const payoutValues = currencies.map((row) => (
    range === "lifetime" ? row.lifetimePaidPayouts.amount : row.periodPaidPayouts.amount
  ));

  return (
    <div className="space-y-3">
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-surface p-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Time range</h2>
          <p className="mt-0.5 text-xs text-slate-500" aria-live="polite">{rangeDescription}</p>
        </div>
        <div
          role="group"
          aria-label="Financial report time range"
          className="inline-flex rounded-xl border border-slate-200 bg-slate-100 p-1"
        >
          <RangeButton active={range === "lifetime"} onClick={() => setRange("lifetime")}>Lifetime</RangeButton>
          <RangeButton active={range === "period"} onClick={() => setRange("period")}>Last {finance.period.days} days</RangeButton>
        </div>
      </section>

      {hkdEstimate ? (
        <HkdEstimate
          totals={hkdEstimate[range]}
          fx={hkdEstimate.fx}
        />
      ) : (
        <section className="rounded-2xl border border-slate-200 bg-surface p-3.5">
          <h2 className="text-sm font-semibold text-slate-900">Estimated in HKD</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            {hkdUnavailableMessage(finance)}
          </p>
        </section>
      )}

      {anthropic && <AiCostCoverage cost={anthropic} />}

      <section aria-labelledby="exact-currencies-heading">
        <div className="mb-2">
          <h2 id="exact-currencies-heading" className="text-sm font-semibold text-slate-900">Original currencies</h2>
          <p className="mt-0.5 text-xs text-slate-500">Amounts stay in the currencies reported or recorded.</p>
        </div>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
          <MoneyCard label="Customer paid" values={gross} hint="Completed payments before refunds and fees." />
          <MoneyCard label="Stripe fees" values={fees} hint="Processing fees reported by Stripe." />
          <MoneyCard label="You received" values={received} hint="After Stripe fees, refunds and disputes." />
          <MoneyCard
            label="AI cost"
            values={aiCost}
            hint={anthropic ? aiCostSource(anthropic) : "AI cost data is unavailable."}
          />
          <MoneyCard
            label="After AI"
            values={contribution ? [contribution] : []}
            hint={exactContribution
              ? "You received minus the AI cost shown. Hosting and tax are not included."
              : "An exact total needs receipts and AI cost in the same currency."}
          />
        </div>
      </section>

      {range === "period" && (
        <section className="grid gap-3 lg:grid-cols-2" aria-label={`${rangeName} trends`}>
          {hkdEstimate ? (
            <FinanceTrendChart
              title="You received"
              summary={`${formatExactMoney(hkdEstimate.period.received)} HKD estimated for the last ${finance.period.days} days`}
              label="Estimated in HKD"
              currency="HKD"
              points={hkdEstimate.daily.map((row) => ({ day: row.day, value: exactMoneyMajor(row.received) }))}
            />
          ) : primary ? (
            <FinanceTrendChart
              title="You received"
              summary={`${formatExactMoney(primary.period.net)} ${primary.currency} received in the last ${finance.period.days} days`}
              label="You received"
              currency={primary.currency}
              points={primary.daily.map((row) => ({ day: row.day, value: exactMoneyMajor(row.operatingNet) }))}
            />
          ) : (
            <Unavailable text={currencies.length > 1 ? "The receipt currencies are shown separately above and are not merged into one chart." : "Stripe receipt data is unavailable."} />
          )}
          {hkdEstimate ? (
            <FinanceTrendChart
              title="AI cost"
              summary={`${formatExactMoney(hkdEstimate.period.aiCost)} HKD estimated for the last ${finance.period.days} days`}
              label="Estimated in HKD"
              currency="HKD"
              points={hkdEstimate.daily.map((row) => ({ day: row.day, value: exactMoneyMajor(row.aiCost) }))}
              tone="negative"
            />
          ) : anthropic ? (
            <FinanceTrendChart
              title="AI cost"
              summary={`${formatExactMoney(anthropic.period.cost)} ${anthropic.period.cost.currency} charged in the last ${finance.period.days} days`}
              label="AI cost"
              currency={anthropic.period.cost.currency}
              points={anthropic.daily.map((row) => ({ day: row.day, value: exactMoneyMajor(row.cost) }))}
              tone="negative"
            />
          ) : (
            <Unavailable text="AI cost data is unavailable." />
          )}
        </section>
      )}

      <section className="rounded-2xl border border-slate-200 bg-surface p-3.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Paid to your bank</h2>
            <p className="mt-0.5 text-xs text-slate-500">A payout moves your Stripe balance. It is not new income.</p>
          </div>
          <MoneyValues label={`Paid to your bank, ${rangeName}`} values={payoutValues} compact />
        </div>
        <details className="mt-2 border-t border-slate-200 pt-2 text-xs text-slate-600">
          <summary className="cursor-pointer font-medium text-slate-700">View Stripe details for {rangeName.toLowerCase()}</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {currencies.flatMap((row) => row.categories
              .filter((category) => category[range].count > 0)
              .map((category) => (
                <div key={`${row.currency}-${category.category}`} className="rounded-xl border border-slate-200 px-3 py-2">
                  <div className="flex justify-between gap-3">
                    <span>{category.category.replaceAll("_", " ")}</span>
                    <span className="tabular-nums">{formatExactMoney(category[range].net)} <span className="text-[10px] text-slate-400">{row.currency}</span></span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {category[range].count.toLocaleString()} entries. {categoryExplanation(category.classification)}
                  </p>
                </div>
              )))}
          </div>
        </details>
      </section>

      {currencies.some((row) => exactMoneyMajor(row[range].unknownNet) !== 0) && (
        <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50/60 px-3 py-2 text-xs leading-5 text-amber-900">
          This range includes an unrecognised Stripe category. It appears in the details but is excluded from You received until reviewed.
        </p>
      )}
    </div>
  );
}

function MoneyCard({ label, values, hint }: { label: string; values: ExactMoney[]; hint: string }) {
  return (
    <section className="min-w-0 rounded-2xl border border-slate-200 bg-surface p-3.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <MoneyValues label={label} values={values} />
      <p className="mt-1 text-[11px] leading-4 text-slate-500">{hint}</p>
    </section>
  );
}

function HkdEstimate({ totals, fx }: { totals: HkdFinanceTotals; fx: HkdFxSnapshot }) {
  const values = [
    ["Customer paid", totals.customerPaid],
    ["Stripe fees", totals.stripeFees],
    ["You received", totals.received],
    ["AI cost", totals.aiCost],
    ["After AI", totals.afterAi],
  ] as const;

  return (
    <section aria-labelledby="hkd-estimate-heading" className="rounded-2xl border border-slate-200 bg-surface p-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 id="hkd-estimate-heading" className="text-sm font-semibold text-slate-900">Estimated in HKD</h2>
          <p className="mt-0.5 text-xs text-slate-500">Planning estimate only. Hosting and tax are not included.</p>
        </div>
        <a
          href={fx.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-slate-500 underline underline-offset-4 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
        >
          {fx.source}, as of {date(fx.asOf)}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-slate-200 pt-3 xl:grid-cols-5">
        {values.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</dt>
            <dd className="mt-0.5 text-xl font-semibold tabular-nums text-slate-900">
              {formatExactMoney(value)} <span className="text-[11px] font-medium text-slate-400">HKD</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function AiCostCoverage({ cost }: { cost: AnthropicCostSnapshot }) {
  const coverage = cost.coverage.historicalComplete
    ? "Full requested history included."
    : cost.coverage.startsAt
      ? `Costs before ${date(cost.coverage.startsAt)} are excluded.`
      : "Earlier costs are excluded.";

  return (
    <p className="rounded-xl border border-slate-200 bg-surface px-3 py-2 text-xs leading-5 text-slate-500">
      <span className="font-medium text-slate-700">AI cost source:</span> {aiCostSource(cost)} {coverage} Updated {date(cost.asOf)}.
    </p>
  );
}

function aiCostSource(cost: AnthropicCostSnapshot): string {
  if (cost.source === "anthropic_cost_api") {
    return cost.workspaceFiltered ? "Anthropic billing report for BandUp." : "Anthropic billing report.";
  }
  return cost.coverage.includesProviderBackfill
    ? "BandUp cost ledger with imported billing history."
    : "BandUp cost ledger.";
}

function hkdUnavailableMessage(finance: FinanceData): string {
  if (finance.providers?.stripe && !finance.providers.stripe.available) {
    return "Stripe data is unavailable, so the HKD estimate cannot be calculated.";
  }
  if (finance.providers?.anthropic && !finance.providers.anthropic.available) {
    return "AI cost data is unavailable, so the HKD estimate cannot be calculated.";
  }
  if (finance.providers?.fx && !finance.providers.fx.available) {
    return finance.providers.fx.reason?.message ?? "HKMA exchange-rate data is unavailable.";
  }
  return finance.contributionStatus?.reason?.message ?? "An HKD estimate is unavailable.";
}

function MoneyValues({ label, values, compact = false }: { label: string; values: ExactMoney[]; compact?: boolean }) {
  if (values.length === 0) {
    return <p className={`${compact ? "text-sm" : "mt-1 text-xl"} font-semibold text-slate-500`}>Unavailable</p>;
  }

  return (
    <ul aria-label={`${label} by currency`} className={compact ? "space-y-0.5 text-right" : "mt-1 space-y-0.5"}>
      {values.map((value) => (
        <li key={value.currency} className={`${compact ? "text-sm" : "text-xl"} font-semibold tabular-nums text-slate-900`}>
          {formatExactMoney(value)} <span className={`${compact ? "text-[10px]" : "text-[11px]"} font-medium text-slate-400`}>{value.currency}</span>
        </li>
      ))}
    </ul>
  );
}

function RangeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 ${
        active ? "bg-slate-900 text-slate-50 shadow-sm" : "text-slate-600 hover:bg-surface hover:text-slate-900"
      }`}
    >
      {children}
    </button>
  );
}

function categoryExplanation(classification: "operating" | "money_movement" | "unknown"): string {
  if (classification === "operating") return "Included in You received.";
  if (classification === "money_movement") return "Balance movement, not income.";
  return "Excluded until reviewed.";
}

function date(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(value));
}

function Unavailable({ text }: { text: string }) {
  return <section className="grid min-h-36 place-items-center rounded-2xl border border-slate-200 bg-surface p-5 text-center text-sm text-slate-500">{text}</section>;
}
