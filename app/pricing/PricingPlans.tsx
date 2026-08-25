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
import SignInLink from "@/components/account/SignInLink";
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
  walletMethodList,
  type BillingInterval,
  type PlanId,
  type Tier,
  type WalletPaymentMethod,
} from "@/lib/billing/tiers";

/*
  The plans, side by side, with the reader's own marked.

  ---------------------------------------------------------------------------
  Two ways to pay, and one of them is the default

  A card subscription and a wallet pass are not the same purchase and cannot be
  made into one. Alipay and WeChat Pay cannot take a recurring charge, and Stripe
  will not put a subscription and a one-off on the same Checkout Session — so
  "one button offering all three" is not a thing that can be built, whatever the
  page looks like.

  What the page can decide is which one somebody lands on without thinking, and
  it is the subscription: a full-width primary button that says in its own label
  that it renews. The wallets sit under it as a quieter alternative — a line of
  text, below a rule, in smaller type — for the buyer who has no card that works
  here, which for a mainland candidate is the ordinary case rather than the edge
  one.

  The two controls were the same width and weight before, which asked everybody
  to make a decision most people had no basis for making, and left the cheaper
  path for us and the worse-remembered path for them looking equally
  recommended.

  Both sets of terms sit beside their own control. That is deliberate: a
  subscription's renewal terms have to be in visual proximity to the thing that
  agrees to them, and a pass's ending has to be next to the thing that buys it,
  or the disclosure is a document two pages away.

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
  /**
   * Which wallets this Stripe account is actually approved for.
   *
   * Optional, and defaulted to Alipay alone, because an older cached response
   * will not carry it — and a button that promises a wallet the account cannot
   * take is exactly the failure this field exists to prevent.
   */
  walletMethods?: WalletPaymentMethod[];
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
          const walletMethods = config?.walletMethods?.length ? config.walletMethods : (["alipay"] as WalletPaymentMethod[]);
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
                    walletMethods={walletMethods}
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
      <SignInLink className="btn-secondary w-full">
        Create a free account
      </SignInLink>
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
  walletMethods,
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
  /** The wallets Stripe will actually accept, so the button names only those. */
  walletMethods: readonly WalletPaymentMethod[];
  configPhase: ConfigPhase;
  account: ReturnType<typeof useTier>;
  busy: boolean;
  /** The reader's own currency, so the small print agrees with the big price. */
  currency: string;
  onStart: (path: string, body?: unknown) => void;
}) {
  /*
    What somebody already on this plan is offered, which depends on what they
    hold rather than on what is for sale.

    A subscriber gets one button and it is the one that cancels. Making that
    harder to find than the subscribe button is the oldest trick in this
    business and it is not being played here.

    A pass holder is a different person with a different problem. They have
    nothing to cancel — the payment was made once and nothing is scheduled — so
    "Manage billing" opened a portal with no subscription in it, over the word
    "Access", which said nothing about the fact that the access stops. They get
    the date it ends and both ways to carry on: subscribe, or buy another pass.

    One line for that, and measured rather than chosen: three lines of it put the
    bottom of this card 52px below the fold on a 1280x720 laptop, and the whole
    point of the layout is that both payment controls are reachable without
    scrolling. What it drops is said twice more in the same card anyway — the pass
    line under the wallet link, and the billing page this sentence points at.
  */
  if (isCurrent) {
    const date = account.expiresAt
      ? new Date(account.expiresAt).toLocaleDateString()
      : null;

    if (account.renews === false) {
      return (
        <div className="flex flex-col gap-2">
          <p className="text-xs leading-5 text-slate-500">
            {date ? `Pass ends ${date} — nothing to cancel.` : "You hold a pass, not a subscription."}
          </p>
          <PayControls
            planId={planId}
            planOffered={planOffered}
            walletOffered={walletOffered}
            walletMethods={walletMethods}
            busy={busy}
            currency={currency}
            onStart={onStart}
          />
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-2">
        {date && (
          <p className="text-xs leading-5 text-slate-500">
            {account.renews === true
              ? `Renews on ${date}, until you cancel.`
              : /* The date is known and what happens on it is not — see
                   `renews` in lib/billing/useTier.ts. */
                `Access through ${date}.`}
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
        <SignInLink className="btn-primary w-full">
          Sign in to continue
        </SignInLink>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/*
        The subscription's terms, then the subscribe button, then — quieter, and
        below a rule — the wallets and theirs.

        The subscription print stays *above* its button for the reason it always
        did. Every card in the row has to end on the same element or the row looks
        broken, and California's Automatic Renewal Law — the strictest of the
        several that apply, and so the one worth writing to — asks for the renewal
        terms "in visual proximity" to the control that agrees to them, in a way
        the buyer cannot reasonably miss. A link to a document two pages away does
        not satisfy it, and more to the point does not satisfy the person: nobody
        should discover the word "automatically" a month after agreeing to it.

        Four facts, in the order somebody needs them: what it costs, how often,
        that it keeps going, and how to make it stop.
      */}
      <PayControls
        planId={planId}
        planOffered={planOffered}
        walletOffered={walletOffered}
        walletMethods={walletMethods}
        busy={busy}
        currency={currency}
        onStart={onStart}
      />
    </div>
  );
}

/**
 * The two ways to pay, in the order the page recommends them.
 *
 * Shared by the buy state and by the state a pass holder sees, because those two
 * offer the same pair of controls and must not drift into describing them
 * differently — one of them saying a wallet pass renews would be the exact bug
 * this whole change is about.
 *
 * One label each, and no variant for the pass holder. "Subscribe instead" and
 * "Or buy another pass" read slightly better to somebody already holding a pass,
 * and both wrapped onto a second line in a four-column deck — which put the
 * bottom of their card below the fold. The plain labels say the same thing in the
 * space there is.
 */
function PayControls({
  planId,
  planOffered,
  walletOffered,
  walletMethods,
  busy,
  currency,
  onStart,
}: {
  planId: PlanId;
  planOffered: boolean;
  walletOffered: boolean;
  walletMethods: readonly WalletPaymentMethod[];
  busy: boolean;
  currency: string;
  onStart: (path: string, body?: unknown) => void;
}) {
  const plan = PLANS[planId];
  const period = plan.interval === "year" ? "year" : "month";
  const cardPrice = formatPrice(amountIn(plan, currency), currency);
  /*
    What the wallet will charge, which is not what the card charges.

    A wallet payment is always in the base currency: Stripe refuses a Session
    whose currency the merchant's account has not been approved for with that
    wallet, and it refused Singapore dollars for Alipay. So this card may quote
    two currencies — the reader's for the card, Hong Kong dollars for the
    wallet — and that is honest, where agreeing with itself would not be.
  */
  const walletIn = walletCurrency(plan);
  const walletPrice = formatPrice(amountIn(plan, walletIn), walletIn);
  const walletNames = walletMethodList(walletMethods);
  const walletLength = plan.interval === "year" ? "One year" : "One month";

  return (
    <>
      {planOffered && (
        <>
          {/*
            Every fact the law asks for, in as few words as they fit into: the
            amount, how often, that it renews on its own, and where to stop it.
            "by card" went because the button beneath says so, and the card has to
            end above the fold on a 390px phone.

            One step darker than the print it replaced, and the pass line below it
            with it. Measured against the composited card background, slate-500
            came out at 3.32:1 in the default warm theme — under AA for text this
            small, on the two sentences that most have to be read. slate-600 is
            5.02:1 and costs nothing.
          */}
          <p className="pricing-card-terms text-xs leading-5 text-slate-600">
            {cardPrice} every {period}, renewing automatically until you cancel — cancel any time on
            your billing page. See the{" "}
            <Link href="/terms" className="underline underline-offset-2 hover:text-slate-700">
              terms
            </Link>
            .
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => onStart("/api/billing/checkout", { plan: planId })}
            className="pricing-subscribe-button btn-primary w-full"
          >
            {busy ? (
              <LoadingIndicator label="Opening checkout…" announce={false} />
            ) : (
              /* The label says it renews. Somebody who reads nothing else on the
                 card reads the thing they are pressing. */
              `Subscribe — renews ${plan.interval === "year" ? "yearly" : "monthly"}`
            )}
          </button>
        </>
      )}

      {walletOffered && (
        /*
          The alternative, and drawn as one.

          It is a line of text under a rule rather than a second full-width
          button, because the two are not equal offers: a subscription keeps
          working without anybody remembering it, and a pass stops. It is not
          hidden either — somebody with no card that works here needs to find it
          on the first read, and for a candidate paying from the mainland that is
          the normal case.

          One control for both wallets, where there were two. A Session can list
          both, and then Stripe's own page offers the choice — on the screen where
          the buyer can see each one's logo and, for WeChat, the QR code. It
          cannot also swallow the card: a card sale is a subscription and a wallet
          sale is a single prepaid payment, and Stripe models those as different
          Session modes, so one Session cannot be both.
        */
        <div className="pricing-wallet-alternative mt-0.5 border-t border-slate-200 pt-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => onStart("/api/billing/wallet-checkout", { plan: planId })}
            className="pricing-wallet-button text-xs font-medium text-slate-600 underline underline-offset-2 hover:text-slate-900 disabled:opacity-60"
          >
            {busy ? (
              <LoadingIndicator label="Opening checkout…" announce={false} />
            ) : (
              `Or pay ${walletPrice} once with ${walletNames}`
            )}
          </button>
          {/*
            The pass's own terms, next to the pass's own control, and kept to one
            line on purpose — the card has to end above the fold on a 390px phone
            and a 720p laptop, and this is the last thing in it. So it carries the
            three facts that cannot be left to another page: how long, that it does
            not renew, and what happens then. The date it ends on is on the billing
            page from the moment the payment lands, and the fold-out below this deck
            says so at length.
          */}
          <p className="pricing-wallet-terms mt-1 text-[11px] leading-4 text-slate-600">
            {walletLength}, and it does not renew — then back to Free.
          </p>
        </div>
      )}
    </>
  );
}
