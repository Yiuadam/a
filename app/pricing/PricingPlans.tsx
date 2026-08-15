"use client";

import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import Link from "next/link";
import LoadingIndicator from "@/components/LoadingIndicator";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { useTier } from "@/lib/billing/useTier";
import {
  PLANS,
  amountIn,
  SELLABLE_TIERS,
  TIERS,
  formatPrice,
  isPaidTier,
  perMonthEquivalent,
  plansForTier,
  walletCurrency,
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
  /** One-time Alipay and WeChat Pay checkout for prepaid monthly/yearly access. */
  walletCheckout?: boolean;
  plans: PlanId[];
  /**
   * Which currency to print, resolved from the reader's address by the server.
   *
   * Optional because an older cached response may not carry it, and a page that
   * threw on a missing field would be a worse failure than one that falls back
   * to the base currency.
   */
  currency?: string;
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
      className="interval-toggle-base relative inline-grid grid-cols-2 rounded-xl p-1"
      style={{ "--interval-index": value === "month" ? 0 : 1 } as CSSProperties}
    >
      <span className="interval-toggle-selector" aria-hidden="true" />
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onChange(option.id)}
          aria-pressed={value === option.id}
          className={`relative z-10 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors sm:px-4 ${
            value === option.id ? "text-slate-900" : "text-slate-600 hover:text-slate-900"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** The plan a tier sells at a given interval, or null for the free tier. */
function planFor(tier: Tier, interval: BillingInterval): PlanId | null {
  const plan = plansForTier(tier).find((p) => p.interval === interval);
  return plan ? plan.id : null;
}

function Price({
  tier,
  interval,
  currency,
}: {
  tier: Tier;
  interval: BillingInterval;
  currency: string;
}) {
  const id = planFor(tier, interval);
  if (id === null) {
    return (
      <p className="pricing-plan-price mt-4">
        <span className="text-[28px] font-semibold text-slate-900">Free</span>
        <span className="ml-2 text-sm text-slate-500">no card, no trial that expires</span>
      </p>
    );
  }

  const plan = PLANS[id];
  /*
    The reader's own currency, from their address rather than their browser's
    language: somebody in Hong Kong with an English keyboard is not paying in
    dollars. Stripe Checkout resolves the same way, so what this prints is what
    the card is charged.
  */
  const amount = amountIn(plan, currency);

  return (
    <div className="pricing-plan-price mt-4">
      <p>
        <span className="text-[28px] font-semibold text-slate-900">
          {formatPrice(amount, currency)}
        </span>
        <span className="ml-2 text-sm text-slate-500">
          {plan.interval === "year" ? "a year" : "a month"}
        </span>
      </p>
      {plan.interval === "year" && (
        <p className="mt-1 text-sm text-slate-500">
          That works out at {formatPrice(perMonthEquivalent(plan, currency), currency)} a month.
        </p>
      )}
    </div>
  );
}

export default function PricingPlans({
  children,
  initialCurrency,
}: {
  children?: ReactNode;
  /**
   * The reader's currency as the server already resolved it from their
   * address, so the first paint carries the right money rather than the base
   * currency corrected a round trip later. Null in the static iOS export,
   * where there is no request to read — see lib/billing/region.ts.
   */
  initialCurrency?: string | null;
}) {
  const account = useTier();
  const [interval, setInterval] = useState<BillingInterval>("month");
  const [config, setConfig] = useState<BillingConfig | null>(null);
  const [configPhase, setConfigPhase] = useState<ConfigPhase>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    /*
      Stripe replaces this tab. When somebody presses the browser's Back
      button, Safari and Chrome commonly restore the pricing page from the
      back-forward cache instead of mounting it again. React state therefore
      still contained `busy = true`, leaving every payment button disabled and
      saying "Opening checkout…" even though Checkout had been left.

      `pageshow` runs for both a normal history return and a BFCache restore.
      Resetting here is safe on the initial visit (the state is already false)
      and makes a returned page immediately usable without a hard reload.
    */
    const onPageShow = () => setBusy(false);
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

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
  /*
    The reader's currency, resolved server-side from their address — and now
    known before this component ever mounts, because the page read it while
    rendering and handed it down (lib/billing/region.ts).

    That ordering is the whole point. This used to be `config?.currency ??
    base`, so every reader in the world was shown Hong Kong dollars until a
    round trip completed and then watched the number change. A price is not
    something to get provisionally right: somebody in London read HK$4.90, and
    somebody whose request failed went on reading it.

    The config answer still wins when it arrives, because it comes from the
    same server and costs nothing to prefer. The base currency remains at the
    end of the chain for the static iOS export, which has no request to read
    and so genuinely does not know until it asks.
  */
  const currency = config?.currency ?? initialCurrency ?? PLANS["plus-monthly"].currency;

  return (
    <div className="pricing-plans space-y-2 sm:space-y-4">
      <div className="pricing-heading-row flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold leading-8 text-slate-900 sm:text-[26px]">
          Plans
        </h1>
        <IntervalToggle value={interval} onChange={setInterval} />
      </div>

      {children}

      {error && (
        <p
          role="alert"
          className="rounded-2xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700"
        >
          {error}
        </p>
      )}

      <p className="pricing-swipe-hint text-xs font-medium text-slate-500 sm:hidden">
        Swipe to compare all four plans →
      </p>

      {/* One snap-scrolling deck on phones; two or four columns once the
          screen is wide enough to compare plans without squeezing them. */}
      <div className="pricing-plan-track" aria-label="Subscription plans">
        {SELLABLE_TIERS.map((id) => {
          const tier = TIERS[id];
          const planId = planFor(id, interval);
          const planOffered =
            planId !== null && checkoutOpen && config?.plans.includes(planId) === true;
          const walletOffered = planId !== null && config?.walletCheckout === true;
          /*
            An admin is marked as being on Pro rather than on a fifth plan
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
                  ? "pricing-plan-card card flex flex-col border-indigo-300 ring-1 ring-indigo-300"
                  : "pricing-plan-card card flex flex-col"
              }
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-[18px] font-semibold text-slate-900">{tier.name}</h2>
                {isCurrent && (
                  <span className="rounded-full bg-indigo-100 px-2.5 py-1 text-xs font-medium text-indigo-700">
                    Your plan
                  </span>
                )}
              </div>

              <p className="pricing-plan-blurb mt-2 text-sm leading-6 text-slate-600">
                {tier.blurb}
              </p>

              <Price tier={id} interval={interval} currency={currency} />

              <ul className="pricing-plan-includes mt-5 flex-1 space-y-2.5">
                {tier.includes.map((line) => (
                  <li key={line} className="flex gap-2 text-sm leading-6 text-slate-700">
                    <Check />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>

              <div className="pricing-plan-action mt-6">
                {!isPaidTier(id) || planId === null ? (
                  <FreeAction isCurrent={isCurrent} account={account} />
                ) : (
                  <PaidAction
                    isCurrent={isCurrent}
                    planId={planId}
                    planOffered={planOffered}
                    walletOffered={walletOffered}
                    configPhase={configPhase}
                    account={account}
                    busy={busy}
                    currency={currency}
                    onStart={start}
                  />
                )}
              </div>
            </section>
          );
        })}
      </div>

      {/*
        Which plan you are on, below the deck rather than above it.

        It was a line of its own between the heading and the cards, and it cost
        about forty pixels there — enough, on a 1280x800 laptop, to push the
        payment buttons off the bottom of the screen. It is not needed before
        the cards anyway: the card you are on already wears a "Your plan" pill,
        which says the same thing in the place you are looking.
      */}
      {account.phase === "ready" && account.accountsEnabled && account.signedIn && (
        <p className="pricing-account-status text-right text-sm text-slate-500">
          {currentTier === "admin"
            ? "This account has no limits."
            : `You're on ${TIERS[currentTier ?? "free"].name}.`}
        </p>
      )}
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

function PaidAction({
  isCurrent,
  planId,
  planOffered,
  walletOffered,
  configPhase,
  account,
  busy,
  currency,
  onStart,
}: {
  isCurrent: boolean;
  planId: PlanId;
  planOffered: boolean;
  walletOffered: boolean;
  configPhase: ConfigPhase;
  account: ReturnType<typeof useTier>;
  busy: boolean;
  /** The reader's own currency, so the small print agrees with the big price. */
  currency: string;
  onStart: (path: string, body?: unknown) => void;
}) {
  /*
    A subscriber gets one button and it is the one that cancels. Making that
    harder to find than the subscribe button is the oldest trick in this
    business and it is not being played here.
  */
  if (isCurrent) {
    return (
      <div className="flex flex-col gap-2">
        {account.expiresAt && (
          <p className="text-xs leading-5 text-slate-500">
            Access through {new Date(account.expiresAt).toLocaleDateString()}.
          </p>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => onStart("/api/billing/portal")}
          className="btn-secondary w-full"
        >
          {busy ? <LoadingIndicator label="Opening…" announce={false} /> : "Manage billing"}
        </button>
      </div>
    );
  }

  if (configPhase === "loading" || account.phase === "loading") {
    return <p className="text-sm text-slate-500"><LoadingIndicator label="Checking…" /></p>;
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
  if (!planOffered && !walletOffered) {
    return (
      <p className="text-sm leading-6 text-slate-500">
        Payments aren&rsquo;t open yet. The placement test, your study plan and every drill are free
        either way, and a free account syncs your progress between devices.
      </p>
    );
  }

  if (account.accountsEnabled && !account.signedIn) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs leading-5 text-slate-500">
          Paid access attaches to an account, so the account comes first. It is free.
        </p>
        <Link href="/account" className="btn-primary w-full">
          Sign in to continue
        </Link>
      </div>
    );
  }

  /*
    The renewal terms sit here, attached to the button, and not only in the
    terms of use — and *above* it rather than below.

    Above, because every card in the row has to end on its button or the row
    looks broken: a card whose small print is four lines long and one whose
    renewal date is one line put their buttons a hundred pixels apart when the
    print sits underneath. Putting the print first makes the button the last
    thing in every card, so every button lands on the same line. It also means
    the terms are read on the way to the button rather than after it, which is
    the order they are for.

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
  const plan = PLANS[planId];
  const period = plan.interval === "year" ? "year" : "month";
  const cardPrice = formatPrice(amountIn(plan, currency), currency);
  /*
    What the wallet will charge, which is not always what the card charges.
    Neither Alipay nor WeChat Pay accepts every currency the catalogue prices
    in, so `walletCurrency` falls back to the base one where they do not — and
    the sentence below then quotes the figure that will actually appear on
    Stripe's page rather than the one this card happens to be showing.
  */
  const walletIn = walletCurrency(plan, currency);
  const walletPrice = formatPrice(amountIn(plan, walletIn), walletIn);

  return (
    <div className="flex flex-col gap-2">
      {/*
        All of the small print, then both buttons, in that order.

        The print stays above the buttons for the reason it always did — every
        card in the row has to end on a button or the row looks broken, and the
        renewal terms have to be in visual proximity to the control that agrees
        to them. What changed is that there is now one block of print rather
        than one above the card button and another wedged between the two, so
        the buttons sit together and both are reachable without scrolling.
      */}
      <p className="text-xs leading-5 text-slate-500">
        {planOffered && (
          <>
            {cardPrice} every {period} by card, renewing automatically until you cancel — cancel
            any time from your billing page.{" "}
          </>
        )}
        {walletOffered && (
          <>
            Alipay and WeChat Pay charge {walletPrice} once, for {plan.interval === "year" ? "one year" : "one month"},
            and do not renew.{" "}
          </>
        )}
        See the{" "}
        <Link href="/terms" className="underline underline-offset-2 hover:text-slate-700">
          terms
        </Link>
        .
      </p>

      {planOffered && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onStart("/api/billing/checkout", { plan: planId })}
          className="pricing-subscribe-button btn-primary w-full"
        >
          {busy ? <LoadingIndicator label="Opening checkout…" announce={false} /> : "Subscribe by card"}
        </button>
      )}

      {walletOffered && (
        <div>
          {/*
            One button for both wallets, where there were two.

            They were two because the old Checkout Session named a single
            payment method. It does not have to: a Session can list both, and
            then Stripe's own page offers the choice — on the screen where the
            buyer can see each one's logo and, for WeChat, the QR code. Asking
            them to commit to a wallet before they have left this page was
            asking the question in the wrong place, and it cost a whole row of
            the card, which is what pushed these buttons off the bottom of the
            screen.

            It cannot swallow the card button as well. A card sale is a
            subscription that renews and a wallet sale is a single prepaid
            payment; Stripe models those as different Session modes, so one
            Session cannot be both. They sit next to each other instead.
          */}
          <button
            type="button"
            disabled={busy}
            onClick={() => onStart("/api/billing/wallet-checkout", { plan: planId })}
            className="pricing-wallet-button btn-secondary w-full"
          >
            {busy ? (
              <LoadingIndicator label="Opening checkout…" announce={false} />
            ) : (
              "Pay once with Alipay or WeChat Pay"
            )}
          </button>
        </div>
      )}
    </div>
  );
}
