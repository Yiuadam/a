"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  authedFetch,
  getServerSnapshot as getSessionServerSnapshot,
  getSnapshot as getSessionSnapshot,
  subscribe as subscribeSession,
} from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { forgetDecision } from "@/lib/billing/free-pro-dismissal";
import { TIERS, type Tier } from "@/lib/billing/tiers";

/*
  The way out of the free Pro trial.

  ---------------------------------------------------------------------------
  Why there is a button at all

  The poster promises that the trial may end and that nothing is ever charged.
  A trial somebody can only leave by writing to us is not really a trial they
  accepted; it is one they are held to. So the exit is a button, it is in the
  same size type as everything else, and it does not argue.

  What it deliberately does not do: no "are you sure", no list of what they will
  lose, no offer of a discount to stay, no counting down. One press, and it is
  done. The consequence is stated above the button instead, where somebody
  deciding can read it before they press rather than after.

  ---------------------------------------------------------------------------
  Why it is on the account page and not the billing page

  /billing is the page for what you pay, and this costs nothing — but the real
  reason is narrower than that. scripts/build-mobile.mjs takes app/billing and
  app/pricing out of the iOS bundle, because Apple requires digital content used
  in an app to be sold through In-App Purchase and BandUp's answer is to sell
  nothing in the app at all. The poster that offers the trial is on the home
  page, which does ship. An exit that existed only on the website would mean a
  learner who accepted in the app could not leave in the app, and the entrance
  and the exit have to be reachable from the same places.

  ---------------------------------------------------------------------------
  Nothing here decides anything

  Whether this draws at all comes from /api/billing/promo, which resolves the
  account's entitlement server-side and answers `grantHeld` only when the trial
  itself is what is granting Pro — not a Stripe or Apple subscription, and not
  the owner's role. DELETE re-establishes the same condition from the session
  before it writes, and only ever touches rows whose provider is 'promo', so no
  paid subscription can be cancelled through it. Editing this file in dev tools
  changes what is drawn and changes nothing about what is held.

  ---------------------------------------------------------------------------
  Why giving up forgets a localStorage key

  The trial is reversible: releasing it makes the offer available again. The
  poster hides itself on a device once it has been answered there, and that flag
  would otherwise hide the one place the offer is made — so the exit clears it.
  See lib/billing/free-pro-dismissal.ts.
*/

interface PromoAnswer {
  grantHeld?: boolean;
}

type Notice =
  | { kind: "released"; tier: Tier | null }
  | { kind: "restarted" }
  | { kind: "problem"; text: string }
  | null;

/**
 * What the account holds now, named rather than assumed.
 *
 * Almost always the free plan, and the exception is why the server sends the
 * tier at all: an account can hold a paid subscription underneath the grant, and
 * "you are on the free plan" would be false for the one person who is paying.
 */
function planName(tier: Tier | null): string {
  if (!tier || tier === "free") return "the free plan";
  return TIERS[tier].name;
}

export default function GiveUpFreeProSection({ onChanged }: { onChanged?: () => void }) {
  const session = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionServerSnapshot,
  );
  const [held, setHeld] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    /*
      A sign-out or a sign-in re-runs this. `alive` keeps an older answer from
      landing last and drawing the previous account's card, and the reset happens
      in the cleanup rather than in the effect body so that a signed-out reader
      costs no render at all.
    */
    let alive = true;
    const done = () => {
      alive = false;
      setHeld(false);
    };
    if (!session) return done;

    authedFetch(apiUrl("/api/billing/promo"))
      .then(async (res) => (res.ok ? ((await res.json()) as PromoAnswer) : null))
      .then((body) => {
        if (alive) setHeld(body?.grantHeld === true);
      })
      .catch(() => {
        /* No answer means no card. Silence is the safe direction here. */
      });

    return done;
  }, [session]);

  /*
    Both writes take the server's answer as the new state rather than asking
    again: the route re-established every condition before it wrote, so its
    answer is the authoritative one, and a re-fetch would only put a wrong card
    on the screen for the length of a round trip. `onChanged` re-asks the *plan*
    row above, which is a different question — see components/AccountPanel.tsx.
  */
  const giveUp = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await authedFetch(apiUrl("/api/billing/promo"), { method: "DELETE" });
      const body = (await res.json().catch(() => null)) as
        | { released?: boolean; tier?: Tier; error?: string }
        | null;
      if (res.ok && body?.released === true) {
        /*
          The offer is available again server-side, so this device must be able
          to draw it again. Cleared before the state is set, so a reader who
          navigates straight to the home page finds the poster there.
        */
        forgetDecision();
        setNotice({ kind: "released", tier: body.tier ?? null });
        setHeld(false);
        onChanged?.();
      } else {
        setNotice({
          kind: "problem",
          text:
            typeof body?.error === "string" && body.error.length > 0
              ? body.error
              : "We couldn't change your free Pro trial just now. Nothing has changed — please try again in a minute.",
        });
      }
    } catch {
      setNotice({
        kind: "problem",
        text: "We couldn't reach the server. Nothing has changed. Please check your connection and try again.",
      });
    }
    setBusy(false);
  }, [onChanged]);

  const startAgain = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await authedFetch(apiUrl("/api/billing/promo"), { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | { granted?: boolean; error?: string }
        | null;
      if (res.ok && body?.granted === true) {
        setNotice({ kind: "restarted" });
        setHeld(true);
        onChanged?.();
      } else {
        setNotice({
          kind: "problem",
          text:
            typeof body?.error === "string" && body.error.length > 0
              ? body.error
              : "We couldn't start your free Pro trial just now. Nothing has changed — please try again in a minute.",
        });
      }
    } catch {
      setNotice({
        kind: "problem",
        text: "We couldn't reach the server. Nothing has changed. Please check your connection and try again.",
      });
    }
    setBusy(false);
  }, [onChanged]);

  /*
    Nothing to say: no trial on this account, and nothing has just happened to
    one. The card is absent rather than empty — a heading about a trial somebody
    does not have is a question they did not ask.
  */
  if (!held && notice === null) return null;

  const problem = notice?.kind === "problem" ? notice.text : null;

  if (!held) {
    /* Released, and this is the confirmation. The way back is on it. */
    const tier = notice?.kind === "released" ? notice.tier : null;
    return (
      <section className="card" aria-live="polite">
        <h2 className="text-[17px] font-semibold text-slate-900">
          Your free Pro trial has been given up
        </h2>
        <p className="mt-1.5 text-[15px] leading-7 text-slate-600">
          Your account is on {planName(tier)} now. Everything you have written or practised is
          exactly where it was — your study plan, your test results and your saved words are all
          still there, and nothing has been deleted.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          You can start the trial again while it is still open, either from the button below or
          from the offer on the home page.
        </p>
        {problem && (
          <p className="mt-3 text-[15px] leading-7 text-amber-800" role="alert">
            {problem}
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" onClick={startAgain} disabled={busy}>
            {busy ? "Starting…" : "Start the free Pro trial again"}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <h2 className="text-[17px] font-semibold text-slate-900">Your free Pro trial</h2>
      {notice?.kind === "restarted" && (
        <p className="mt-1.5 text-[15px] leading-7 text-slate-600" aria-live="polite">
          Your free Pro trial is on again, and your account is back on Pro.
        </p>
      )}
      <p className="mt-1.5 text-[15px] leading-7 text-slate-600">
        Pro is on your account as a free trial. Nothing is being charged for it and no card is
        held.
      </p>
      <p className="mt-3 text-[15px] leading-7 text-slate-700">
        If you would rather go back to the free plan, you can give the trial up here. Everything
        you have written or practised stays exactly where it is — the free plan keeps all of it,
        with smaller allowances for the AI marking, the tutor and word lookups. You can start the
        trial again later while it is still open.
      </p>
      {problem && (
        <p className="mt-3 text-[15px] leading-7 text-amber-800" role="alert">
          {problem}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className="btn-secondary" onClick={giveUp} disabled={busy}>
          {busy ? "Giving it up…" : "Give up my free Pro trial"}
        </button>
      </div>
    </section>
  );
}
