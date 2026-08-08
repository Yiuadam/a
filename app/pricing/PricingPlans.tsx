"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { useTier } from "@/lib/billing/useTier";
import {
  PLANS,
  SELLABLE_TIERS,
  TIERS,
  formatPrice,
  perMonthEquivalent,
  type BillingInterval,
  type PlanId,
  type Tier,
} from "@/lib/billing/tiers";

/*
  The plans, side by side, with the reader's own marked.

  ---------------------------------------------------------------------------
  What this page is not allowed to do

  There are no crossed-out prices, no "was £19", no countdown, no "3 people are
  looking at this", and no badge putting a ribbon on whichever plan we would
  rather sell. Every one of those works, which is why they are everywhere, and
  every one of them is a small lie told to somebody who is about to give us
  money. The yearly figure is shown as a total and as the monthly amount it
  divides into — arithmetic the reader can check — rather than as a percentage
  we assert.

  It also does not pretend the free tier is a trap. Almost everything in BandUp
  is free and stays free: the placement test, the study plan, every bundled
  practice test, both sets of drills. That is said at the top rather than
  buried, because it is true and because a paywall that overstates itself
  teaches people to distrust the rest of the app.

  ---------------------------------------------------------------------------
  Nothing here decides anything

  The tier comes from /api/account/status, which resolved it server-side from
  the database. Whether checkout is even possible comes from
  /api/billing/config, because the Stripe key is server-only and the browser
  has no way to find out on its own. Editing either in dev tools changes what
  this page draws and changes nothing about what any route will do — every
  gated route asks the server before it acts (lib/billing/gate.ts). See
  ACCOUNTS.md, threats 1 and 3.
*/

/** What /api/billing/config answers. */
interface BillingConfig {
  checkout: boolean;
  plans: PlanId[];
}

type ConfigPhase = "loading" | "ready" | "unavailable";

function Check() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="mt-1 shrink-0 text-emerald-600"
    >
      <path d="M3 8.5 6.2 12 13 4.5" />
    </svg>
  );
}

function IntervalToggle({
  value,
  onChange,
}: {
  value: BillingInterval;
  onChange: (next: BillingInterval) => void;
}) {
  const options: { id: BillingInterval; label: string }[] = [
    { id: "month", label: "Monthly" },
    { id: "year", label: "Yearly" },
  ];

  return (
    <div
      role="group"
      aria-label="Billing period"
      className="inline-flex rounded-xl border border-slate-200 bg-surface p-1"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onChange(option.id)}
          aria-pressed={value === option.id}
          className={
            value === option.id
              ? "rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-accent-fg"
              : "rounded-lg px-4 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:text-slate-900"
          }
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Price({ tier, interval }: { tier: Tier; interval: BillingInterval }) {
  if (tier === "free") {
    return (
      <p className="mt-4">
        <span className="text-[32px] font-semibold text-slate-900">Free</span>
        <span className="ml-2 text-sm text-slate-500">no card, no trial that expires</span>
      </p>
    );
  }

  const plan = interval === "year" ? PLANS["pro-yearly"] : PLANS["pro-monthly"];

  return (
    <div className="mt-4">
      <p>
        <span className="text-[32px] font-semibold text-slate-900">
          {formatPrice(plan.amountMinor, plan.currency)}
        </span>
        <span className="ml-2 text-sm text-slate-500">
          {plan.interval === "year" ? "a year" : "a month"}
        </span>
      </p>
      {plan.interval === "year" && (
        <p className="mt-1 text-sm text-slate-500">
          That works out at {formatPrice(perMonthEquivalent(plan), plan.currency)} a month.
        </p>
      )}
    </div>
  );
}

export default function PricingPlans() {
  const account = useTier();
  const [interval, setInterval] = useState<BillingInterval>("month");
  const [config, setConfig] = useState<BillingConfig | null>(null);
  const [configPhase, setConfigPhase] = useState<ConfigPhase>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(apiUrl("/api/billing/config"))
      .then(async (res) => {
        if (!res.ok) throw new Error("billing config unavailable");
        return (await res.json()) as BillingConfig;
      })
      .then((body) => {
        if (!alive) return;
        setConfig(body);
        setConfigPhase("ready");
      })
      .catch(() => {
        /*
          Unreachable is not the same as unconfigured, and the page says so:
          a reader is told checkout could not be reached rather than that it
          does not exist. The difference matters to whoever is deploying.
        */
        if (alive) setConfigPhase("unavailable");
      });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Asks the server to start something, then navigates to the URL it hands
   * back. Both billing routes answer the same shape, so both go through here.
   *
   * The button is disabled while a request is in flight. A second click would
   * open a second Checkout Session, which is harmless in Stripe and confusing
   * for the person watching two tabs try to open.
   */
  const start = useCallback(async (path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch(apiUrl(path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const payload = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !payload.url) {
        // The server's message is written for a learner and carries nothing
        // about the server — see lib/auth/errors.ts. It is shown as-is.
        setError(payload.error ?? "Something went wrong. Please try again.");
        setBusy(false);
        return;
      }
      window.location.href = payload.url;
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
      setBusy(false);
    }
  }, []);

  const currentTier = account.tier;
  const checkoutOpen = configPhase === "ready" && config?.checkout === true;
  const planId: PlanId = interval === "year" ? "pro-yearly" : "pro-monthly";
  const planOffered = checkoutOpen && config?.plans.includes(planId) === true;

  return (
    <div className="space-y-6">
      {error && (
        <p
          role="alert"
          className="rounded-2xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700"
        >
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-4">
        <IntervalToggle value={interval} onChange={setInterval} />
        {account.phase === "ready" && account.accountsEnabled && account.signedIn && (
          <p className="text-sm text-slate-500">
            {currentTier === "admin"
              ? "This account has no limits."
              : `You're on ${TIERS[currentTier ?? "free"].name}.`}
          </p>
        )}
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        {SELLABLE_TIERS.map((id) => {
          const tier = TIERS[id];
          /*
            An admin is marked as being on Pro rather than on a fourth plan
            nobody can buy. The account screen is where "no limits" is
            explained; here the only useful thing to say is that everything on
            this page is already included.
          */
          const isCurrent =
            currentTier !== null && (currentTier === id || (currentTier === "admin" && id === "pro"));

          return (
            <section
              key={id}
              className={
                isCurrent
                  ? "card flex flex-col border-indigo-300 ring-1 ring-indigo-300"
                  : "card flex flex-col"
              }
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-[19px] font-semibold text-slate-900">{tier.name}</h2>
                {isCurrent && (
                  <span className="rounded-full bg-indigo-100 px-2.5 py-1 text-xs font-medium text-indigo-700">
                    Your plan
                  </span>
                )}
              </div>

              <p className="mt-2 text-[15px] leading-7 text-slate-600">{tier.blurb}</p>

              <Price tier={id} interval={interval} />

              <ul className="mt-5 flex-1 space-y-3">
                {tier.includes.map((line) => (
                  <li key={line} className="flex gap-2.5 text-[15px] leading-7 text-slate-700">
                    <Check />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-6">
                {id === "free" ? (
                  <FreeAction isCurrent={isCurrent} account={account} />
                ) : (
                  <ProAction
                    isCurrent={isCurrent}
                    planId={planId}
                    planOffered={planOffered}
                    configPhase={configPhase}
                    account={account}
                    busy={busy}
                    onStart={start}
                  />
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function FreeAction({
  isCurrent,
  account,
}: {
  isCurrent: boolean;
  account: ReturnType<typeof useTier>;
}) {
  if (isCurrent) {
    return (
      <p className="text-sm text-slate-500">
        You&rsquo;re on this plan. Nothing to do.
      </p>
    );
  }
  if (account.phase === "ready" && account.accountsEnabled && !account.signedIn) {
    return (
      <Link href="/account" className="btn-secondary w-full">
        Create a free account
      </Link>
    );
  }
  return (
    <p className="text-sm text-slate-500">
      Included with every account, and with no account at all for most of it.
    </p>
  );
}

function ProAction({
  isCurrent,
  planId,
  planOffered,
  configPhase,
  account,
  busy,
  onStart,
}: {
  isCurrent: boolean;
  planId: PlanId;
  planOffered: boolean;
  configPhase: ConfigPhase;
  account: ReturnType<typeof useTier>;
  busy: boolean;
  onStart: (path: string, body?: unknown) => void;
}) {
  /*
    A subscriber gets one button and it is the one that cancels. Making that
    harder to find than the subscribe button is the oldest trick in this
    business and it is not being played here.
  */
  if (isCurrent) {
    return (
      <div className="space-y-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onStart("/api/billing/portal")}
          className="btn-secondary w-full"
        >
          {busy ? "Opening…" : "Manage or cancel"}
        </button>
        {account.expiresAt && (
          <p className="text-xs text-slate-500">
            Renews {new Date(account.expiresAt).toLocaleDateString()}.
          </p>
        )}
      </div>
    );
  }

  if (configPhase === "loading" || account.phase === "loading") {
    return <p className="text-sm text-slate-500">Checking…</p>;
  }

  /*
    The account could not be read, so which tier this reader is already on is
    unknown. Offering "Subscribe" here would risk selling somebody a second
    copy of what they already have, and it would lead to a sign-in error for
    somebody who is signed in. Saying so and stopping is the smaller failure.
  */
  if (account.phase === "unavailable") {
    return (
      <p className="text-sm leading-6 text-slate-500">
        We couldn&rsquo;t check your account just now, so this can&rsquo;t be started. Please
        reload in a moment — nothing else on BandUp is affected.
      </p>
    );
  }

  if (configPhase === "unavailable") {
    return (
      <p className="text-sm leading-6 text-slate-500">
        We couldn&rsquo;t reach the payment service just now, so this can&rsquo;t be started.
        Everything else on BandUp is unaffected.
      </p>
    );
  }

  /*
    The honest empty state, and the one this app deploys in until somebody
    creates the Stripe prices. A button that looked live and failed on the
    first click would be worse than a sentence.
  */
  if (!planOffered) {
    return (
      <p className="text-sm leading-6 text-slate-500">
        Subscriptions aren&rsquo;t open yet. Your study plan and every drill are free either way,
        and a free account raises the daily allowance on AI feedback.
      </p>
    );
  }

  if (account.accountsEnabled && !account.signedIn) {
    return (
      <div className="space-y-2">
        <Link href="/account" className="btn-primary w-full">
          Sign in to subscribe
        </Link>
        <p className="text-xs text-slate-500">
          A subscription attaches to an account, so the account comes first. It is free.
        </p>
      </div>
    );
  }

  /*
    The renewal terms sit here, attached to the button, and not only in the
    terms of use.

    That placement is the requirement rather than a preference. California's
    Automatic Renewal Law — the strictest of the several that apply, and so the
    one worth writing to — asks for the renewal terms "in visual proximity" to
    the thing the buyer clicks, in a way they cannot reasonably miss. A link to
    a document two pages away does not satisfy it, and more to the point does
    not satisfy the person: nobody should discover the word "automatically" a
    month after they agreed to it.

    Four facts, in the order somebody needs them: what it costs, how often,
    that it keeps going, and how to make it stop.
  */
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => onStart("/api/billing/checkout", { plan: planId })}
        className="btn-primary w-full"
      >
        {busy ? "Opening checkout…" : "Subscribe"}
      </button>
      <p className="text-xs leading-5 text-slate-500">
        {formatPrice(PLANS[planId].amountMinor, PLANS[planId].currency)} every{" "}
        {PLANS[planId].interval === "year" ? "year" : "month"}, renewing automatically until you
        cancel.
        Cancel any time from your billing page — it takes one button. Full refund within 14 days
        of any charge, no reason needed. See the{" "}
        <Link href="/terms" className="underline underline-offset-2 hover:text-slate-700">
          terms
        </Link>
        .
      </p>
    </div>
  );
}
