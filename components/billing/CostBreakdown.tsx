import { COSTED_ROUTES, worstCaseCost } from "@/lib/ai/models";
import { toMajor, toMinor } from "@/lib/billing/currency";
import {
  HKD_PER_USD,
  MONTHLY_AI_CAPS,
  PLANS,
  STRIPE_PERCENT_FEE,
  TIERS,
  fixedFeeMinor,
  formatPrice,
  type PlanId,
} from "@/lib/billing/tiers";

/*
  Where the money actually goes, printed rather than claimed.

  ---------------------------------------------------------------------------
  Why this exists, and what it is deliberately not

  The owner's instinct was to say BandUp is "almost a non-profit". The instinct
  is right and the words are not available: non-profit is a legal status granted
  to registered charities, BandUp is one person trading under their own name,
  and claiming the status without holding it is a misrepresentation — under
  Hong Kong's Inland Revenue Ordinance for the charity claim, and under the
  UK and EU unfair-commercial-practices rules as a misleading action. "We make
  no profit" is also not true: every plan clears a margin, by design, because a
  plan that did not would be withdrawn the first month the bill arrived.

  What *is* true is more persuasive than the claim it replaces, and it is
  checkable: most of what a subscriber pays is spent on their behalf the moment
  they use the thing they paid for. So the page prints the arithmetic — price,
  model cost, card fee, remainder — and lets a reader draw their own conclusion.

  ---------------------------------------------------------------------------
  Every figure is computed, and that is the safeguard

  Nothing here is written down. The price comes from the catalogue, the AI cost
  from the same route budgets the server meters against, the card fee from the
  same constants the margin is proved with. A hand-typed "we keep about 10%"
  would be a marketing claim that quietly became false the next time a price
  moved — which is the exact failure the plan feature lists had, and the reason
  tests/billing-tiers.test.mjs now exists.

  The AI figure is the *ceiling*: every allowance spent, every request costing
  the most it can. Said plainly below, because a reader who worked out that
  most people cost less would otherwise have caught us rounding in our own
  favour.
*/

/** What a month of this plan can cost to serve, in US dollars. */
function monthlyAiCost(plan: PlanId): number {
  const tier = PLANS[plan].tier;
  return COSTED_ROUTES.reduce((total, route) => {
    const cap = MONTHLY_AI_CAPS[tier][route] ?? 0;
    return total + cap * worstCaseCost(route);
  }, 0);
}

export default function CostBreakdown({ plan }: { plan: PlanId }) {
  const detail = PLANS[plan];
  const months = detail.interval === "year" ? 12 : 1;

  /*
    Shown in the base currency rather than the reader's, and on purpose. This is
    an account of where the owner's money goes, and it is drawn on the server
    where the reader's currency is not yet known. Converting it per reader would
    also make the arithmetic harder to check rather than easier — the point of
    the section is that the numbers add up, and they add up in one currency.
  */
  const price = toMajor(detail.amountMinor, detail.currency);
  const cardFee = toMajor(
    detail.amountMinor * STRIPE_PERCENT_FEE + fixedFeeMinor(detail.currency),
    detail.currency,
  );
  const ai = monthlyAiCost(plan) * months * HKD_PER_USD;
  const left = price - cardFee - ai;

  const rows: { label: string; amount: number; note: string }[] = [
    {
      label: "The AI that marks your work",
      amount: ai,
      note: "paid to Anthropic, per request, as you use it",
    },
    {
      label: "Card processing",
      amount: cardFee,
      note: "paid to Stripe on every payment",
    },
    {
      label: "Everything else",
      amount: left,
      note: "hosting, the database, and whatever is left over",
    },
  ].filter((row) => row.amount > 0.005);

  const pct = (n: number) => Math.round((n / price) * 100);

  return (
    <section className="card space-y-3">
      <h2 className="text-sm font-semibold text-slate-900">
        Where your {formatPrice(detail.amountMinor, detail.currency)} goes
      </h2>
      <p className="text-[15px] leading-7 text-slate-700">
        BandUp is not a charity and does not pretend to be one — it is one person, and it has to
        cover what it costs to run. But most of what you pay is not kept. It is spent on your
        behalf, the moment you use the thing you paid for.
      </p>

      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.label}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-slate-800">{row.label}</span>
              <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">
                {formatPrice(toMinor(row.amount, detail.currency), detail.currency)}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              {/*
                A bar rather than only a number, because "most of it" is the
                claim and a reader should be able to see it rather than do the
                division.
              */}
              <span
                aria-hidden="true"
                className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100"
              >
                <span
                  className="block h-full rounded-full bg-indigo-500"
                  style={{ width: `${Math.min(100, Math.max(2, pct(row.amount)))}%` }}
                />
              </span>
              <span className="w-9 shrink-0 text-right text-xs tabular-nums text-slate-500">
                {pct(row.amount)}%
              </span>
            </div>
            <p className="mt-0.5 text-xs leading-5 text-slate-500">{row.note}</p>
          </li>
        ))}
      </ul>

      <p className="text-xs leading-5 text-slate-500">
        {ai > 0 ? (
          <>
            The AI figure is the most {TIERS[detail.tier].name} can cost: every allowance spent,
            every request charged at its ceiling. Most people use a fraction of it, and that
            fraction is what pays for the rest of BandUp — the papers, the drills, the study
            plan and the mock exam, which are free and stay free.
          </>
        ) : (
          <>
            {TIERS[detail.tier].name} includes no AI, so nothing here is spent on a model. It
            unlocks work that was already written and is marked against an answer key, which is
            why it can cost what it costs.
          </>
        )}
      </p>
    </section>
  );
}
