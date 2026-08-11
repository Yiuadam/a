"use client";

import ConsoleShell, { NotFound } from "@/components/admin/ConsoleShell";
import FinanceTrendChart from "@/components/admin/FinanceTrendChart";
import { exactMoneyMajor, formatExactMoney } from "@/lib/admin/finance-format";
import type { ExactMoney } from "@/lib/admin/finance-types";
import { estimatedHkdContribution, grossCustomerPayments } from "@/lib/admin/finance-view";
import { useFinance } from "@/lib/admin/useFinance";
import { useTier } from "@/lib/billing/useTier";

export default function FinancePage() {
  const account = useTier();
  const { phase, finance } = useFinance();

  if (phase === "loading") return <p className="px-5 py-6 text-sm text-slate-500">Reading Stripe and Anthropic…</p>;
  if (phase === "denied") return <NotFound mayNeedSignIn={account.phase === "ready" && !account.signedIn} />;

  return (
    <ConsoleShell
      title="Revenue & profit"
      lead="Provider-reported totals. Nothing is inferred from subscriber counts."
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

function FinanceReport({ finance }: { finance: NonNullable<ReturnType<typeof useFinance>["finance"]> }) {
  const currencies = finance.stripe?.currencies ?? [];
  const primary = currencies.length === 1 ? currencies[0] : null;
  const anthropic = finance.anthropic;
  const exactContribution = finance.contribution;
  const estimatedContribution = !exactContribution && primary && anthropic
    ? estimatedHkdContribution(primary, anthropic, "lifetime")
    : null;
  const contribution = exactContribution?.lifetime.contribution ?? estimatedContribution?.total ?? null;
  const gross = currencies.map((row) => grossCustomerPayments(row, "lifetime"));
  const periodLabel = `${finance.period.days} days · UTC`;
  const lifetimeLabel = `Since ${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(finance.lifetimeStartingAt))}`;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MoneyCard label="Gross customer payments" values={gross} hint={lifetimeLabel} />
        <MoneyCard label="Net customer receipts" values={currencies.map((row) => row.lifetime.net)} hint="After Stripe fees, refunds and disputes" />
        <MoneyCard label="AI token cost" values={anthropic ? [anthropic.lifetime.tokenCost] : []} hint={anthropic?.workspaceFiltered ? "BandUp workspace only" : "Anthropic organisation total"} />
        <MoneyCard
          label={exactContribution ? "Contribution after AI" : "Estimated contribution after AI"}
          values={contribution ? [contribution] : []}
          hint={exactContribution ? "Receipts minus AI cost; hosting and taxes are not deducted" : estimatedContribution ? "USD at HK$7.80; hosting and taxes are not deducted" : "Needs matching currencies or an accounting FX rate"}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {primary ? (
          <FinanceTrendChart
            title="Net customer receipts"
            summary={`${formatExactMoney(primary.period.net)} · ${periodLabel}`}
            label="Net receipts"
            currency={primary.currency}
            points={primary.daily.map((row) => ({ day: row.day, value: exactMoneyMajor(row.operatingNet) }))}
          />
        ) : (
          <Unavailable text={currencies.length > 1 ? "Receipts use more than one settlement currency, so they are not merged into a misleading line." : "Stripe receipt data is unavailable."} />
        )}
        {anthropic ? (
          <FinanceTrendChart
            title="AI cost"
            summary={`${formatExactMoney(anthropic.period.cost)} · ${periodLabel}`}
            label="Anthropic cost"
            currency={anthropic.period.cost.currency}
            points={anthropic.daily.map((row) => ({ day: row.day, value: exactMoneyMajor(row.cost) }))}
            tone="negative"
          />
        ) : (
          <Unavailable text="Add an Anthropic Admin API key to show billed AI cost." />
        )}
      </div>

      <section className="rounded-2xl border border-slate-200 bg-surface p-3.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Cash and reconciliation</h2>
            <p className="mt-0.5 text-xs text-slate-500">Payouts are shown separately; moving Stripe balance to a bank is not new revenue.</p>
          </div>
          <p className="text-xs tabular-nums text-slate-600">
            Paid to bank: {currencies.length > 0 ? currencies.map((row) => formatExactMoney(row.lifetimePaidPayouts.amount)).join(" · ") : "Unavailable"}
          </p>
        </div>
        <details className="mt-2 border-t border-slate-200 pt-2 text-xs text-slate-600">
          <summary className="cursor-pointer font-medium text-slate-700">View Stripe categories</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {currencies.flatMap((row) => row.categories.map((category) => (
              <div key={`${row.currency}-${category.category}`} className="rounded-xl border border-slate-200 px-3 py-2">
                <div className="flex justify-between gap-3"><span>{category.category.replaceAll("_", " ")}</span><span className="tabular-nums">{formatExactMoney(category.lifetime.net)}</span></div>
                <p className="mt-0.5 text-[11px] text-slate-400">{category.lifetime.count.toLocaleString()} entries · {category.classification.replaceAll("_", " ")}</p>
              </div>
            )))}
          </div>
        </details>
      </section>

      {currencies.some((row) => exactMoneyMajor(row.lifetime.unknownNet) !== 0) && (
        <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50/60 px-3 py-2 text-xs leading-5 text-amber-900">
          Stripe returned an unrecognised reporting category. It is visible in the breakdown and excluded from net customer receipts until classified.
        </p>
      )}
    </div>
  );
}

function MoneyCard({ label, values, hint }: { label: string; values: ExactMoney[]; hint: string }) {
  return (
    <section className="min-w-0 rounded-2xl border border-slate-200 bg-surface p-3.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 truncate text-xl font-semibold tabular-nums text-slate-900">{values.length > 0 ? values.map(formatExactMoney).join(" · ") : "Unavailable"}</p>
      <p className="mt-1 text-[11px] leading-4 text-slate-500">{hint}</p>
    </section>
  );
}

function Unavailable({ text }: { text: string }) {
  return <section className="grid min-h-36 place-items-center rounded-2xl border border-slate-200 bg-surface p-5 text-center text-sm text-slate-500">{text}</section>;
}
