"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import SignInLink from "@/components/account/SignInLink";
import {
  authedFetch,
  getServerSnapshot as getSessionServerSnapshot,
  getSnapshot as getSessionSnapshot,
  subscribe as subscribeSession,
} from "@/lib/account";
import { apiUrl } from "@/lib/api";
import {
  consumeAutoAcceptIntent,
  dismissedAlready,
  rememberAutoAcceptIntent,
  rememberDecision,
} from "@/lib/billing/free-pro-dismissal";
import { TIERS } from "@/lib/billing/tiers";

/*
  The poster for the free Pro trial.

  ---------------------------------------------------------------------------
  Shown to a guest too, not only a signed-in account

  Eligibility is resolved server-side, per account, so a guest cannot be
  told yes or no — there is no account yet to ask about. Rather than say
  nothing until someone signs in, the pitch itself draws for everyone, and
  "accept" for a guest means "sign up" (see the guest phase below and
  components/account/SignInLink.tsx). Once an account exists the same
  poster asks the real question and shows the real button, same as it
  always did.

  ---------------------------------------------------------------------------
  What it says, and why it says the awkward part

  It offers Pro for nothing, lists what Pro includes, and then — in the body,
  in the same size as everything else, not in small grey type under the button
  — says that the trial may be cancelled at any time in the future and that
  nobody is ever charged without choosing to subscribe.

  That sentence is the reason the poster exists at all. An entitlement that
  simply appeared could not be taken back later without it feeling taken away.
  One that somebody accepted, having been told in the same breath that it can
  end, can be ended as a decision that was announced rather than a punishment.
  So it is not a footnote, and it is not written to be skimmed past.

  ---------------------------------------------------------------------------
  Why it does not nag

  It draws once. Accepting writes a row and the server stops offering it.
  Dismissing writes a key in localStorage and this component stops drawing it
  on this device.

  The key lives in lib/billing/free-pro-dismissal.ts, because giving the trial
  up has to forget it: the server offers the trial again to an account that
  handed it back, and a "seen it" flag left behind here would hide the only
  place that offer is ever made. See components/billing/GiveUpFreeProSection.tsx.
  Why localStorage is the right place for a dismissal and the wrong place for an
  entitlement is written out in that file.

  ---------------------------------------------------------------------------
  Nothing here decides anything

  Whether the offer is available at all comes from /api/billing/promo, which
  resolved it server-side — including whether the database will even accept the
  row. Accepting posts to the same route, which re-establishes every condition
  from the session before it writes. Editing anything in this file in dev tools
  changes what is drawn and changes nothing about what is granted.
*/

type Phase = "idle" | "offered" | "accepting" | "accepted" | "error";

/*
  Never fires — dismissal is read once per mount, not watched for changes
  from elsewhere, so there is nothing to subscribe to. useSyncExternalStore
  is used anyway rather than a plain useState + useEffect pair, because
  that pair is exactly the shape react-hooks/set-state-in-effect exists to
  reject: this value can only be answered from localStorage, which does not
  exist during the server render, so the server snapshot has to say "not
  dismissed" and the real answer can only land after hydration. See
  components/billing/UsageMeter.tsx for the same trade made the same way.
*/
const neverChanges = () => () => {};

export default function FreeProPoster() {
  const session = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionServerSnapshot,
  );
  const dismissed = useSyncExternalStore(neverChanges, dismissedAlready, () => false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string>("");
  /*
    `accept` needs to be callable from the effect below (a guest who tapped
    "Sign up free" is auto-continued the moment a session appears, without
    a second click) but its own identity does not need to be an effect
    dependency — it never changes what the effect is checking, only what
    happens once. A ref sidesteps the ordering problem cleanly: no forward
    reference to a function declared later in the same component.
  */
  const acceptRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const accept = useCallback(async () => {
    setPhase("accepting");
    try {
      const res = await authedFetch(apiUrl("/api/billing/promo"), { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | { granted?: boolean; error?: string }
        | null;
      if (res.ok && body?.granted === true) {
        rememberDecision();
        setPhase("accepted");
        return;
      }
      setMessage(
        typeof body?.error === "string" && body.error.length > 0
          ? body.error
          : "We couldn't start your free Pro trial just now. Please try again in a minute.",
      );
      setPhase("error");
    } catch {
      setMessage(
        "We couldn't reach the server. Please check your connection and try again in a minute.",
      );
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    acceptRef.current = accept;
  }, [accept]);

  useEffect(() => {
    // A sign-out or a sign-in re-runs this. `alive` keeps the older answer from
    // landing last and drawing a poster for the previous account.
    let alive = true;
    /*
      The reset happens in the cleanup rather than here, so an already-
      decided reader costs no render at all and the previous account's
      poster is cleared as the session changes.
    */
    const done = () => {
      alive = false;
      setPhase("idle");
    };
    // A guest is rendered straight from `session`/`dismissed`, not from
    // `phase` — there is nothing to fetch until an account exists to ask
    // about. See the render below.
    if (dismissed || !session) return done;

    authedFetch(apiUrl("/api/billing/promo"))
      .then(async (res) => (res.ok ? ((await res.json()) as { offered?: boolean }) : null))
      .then((body) => {
        if (!alive) return;
        // Read-and-clear regardless of the answer: a guest who signed up
        // gets one auto-continue, not one per reload of the same tab.
        const autoAccept = consumeAutoAcceptIntent();
        if (body?.offered !== true) return;
        if (autoAccept) void acceptRef.current();
        else setPhase("offered");
      })
      .catch(() => {
        /* No answer means no poster. Silence is the safe direction here. */
      });

    return done;
  }, [session, dismissed]);

  const dismiss = useCallback(() => {
    rememberDecision();
    setPhase("idle");
  }, []);

  if (dismissed) return null;

  if (!session) {
    return (
      <section className="card">
        <h2 className="text-[1.0625rem] font-semibold text-slate-900">Pro, free, if you want it</h2>
        {/*
          Kept to two lines and two points on purpose. This sits above the
          practice list on the home page, and at four points and two body
          paragraphs it took nearly half the first screen — pushing the
          skills, the thing a returning learner actually opens the app for,
          below the fold. The offer still has to be understood in full, so
          what went is repetition rather than terms: "free", "no pay" and
          "no card" were three ways of saying one thing, and one is enough.
          The remaining points are the two largest; the full list is a tap
          away on the plans page.
        */}
        <p className="mt-1 text-[0.875rem] leading-6 text-slate-600">
          Pro is the plan for the weeks before your exam, and it is free on every new account —
          no card.
        </p>

        <ul className="mt-2.5 space-y-1">
          {TIERS.pro.includes.slice(0, 2).map((line) => (
            <li key={line} className="flex gap-2.5 text-[0.875rem] leading-5 text-slate-700">
              <span
                aria-hidden="true"
                className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-600"
              />
              {line}
            </li>
          ))}
        </ul>

        {/* A footnote rather than a paragraph. It is a term of the offer and
            has to stay, but it is not what the poster is for, and at body
            size it was costing two lines of the first screen. */}
        <p className="mt-2.5 text-[0.8125rem] leading-5 text-slate-600">
          It starts as soon as you sign up, and may be cancelled at any time in the future.
        </p>

        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          {/*
            An account is what makes the trial an entitlement rather than a
            promise, so "accept" for a guest has to mean "sign up" first.
            The intent survives the trip: consumeAutoAcceptIntent() above
            picks it back up the moment a session exists, so the person who
            tapped this never has to find this poster and press a second
            button — the account they land in already has Pro.
          */}
          <SignInLink
            className="btn-primary"
            onClick={() => rememberAutoAcceptIntent()}
          >
            Sign up free
          </SignInLink>
          <button type="button" className="btn-secondary" onClick={dismiss}>
            No thanks
          </button>
        </div>
      </section>
    );
  }

  // Signed in, but the eligibility check is still in flight or came back
  // false — neither is drawn, same as the original behaviour this restores:
  // the usual case for a signed-in reader is an empty render.
  if (phase === "idle") return null;

  if (phase === "accepted") {
    return (
      <section className="card" aria-live="polite">
        <h2 className="text-[1.0625rem] font-semibold text-slate-900">Your free Pro trial has started</h2>
        <p className="mt-1 text-[0.875rem] leading-6 text-slate-600">
          Your account is on Pro now. Nothing has been charged and no card has been asked for.
          You can see what you have used on your account page, and give the trial up there
          whenever you like.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/account" className="btn-secondary">
            See your account
          </Link>
        </div>
      </section>
    );
  }

  const busy = phase === "accepting";

  return (
    <section className="card">
      <h2 className="text-[1.0625rem] font-semibold text-slate-900">Pro, free, if you want it</h2>
      {/* Trimmed alongside the signed-out poster above, and for the same
          reason. The paragraph below it is not trimmed with them: that one is
          a promise about money, and shortening it would be shortening the
          part a reader is entitled to have in full. */}
      <p className="mt-1 text-[0.875rem] leading-6 text-slate-600">
        Pro is the plan for the weeks before your exam, and it is free on your account — no card.
      </p>

      <ul className="mt-2.5 space-y-1">
        {TIERS.pro.includes.slice(0, 2).map((line) => (
          <li key={line} className="flex gap-2.5 text-[0.875rem] leading-5 text-slate-700">
            <span
              aria-hidden="true"
              className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-600"
            />
            {line}
          </li>
        ))}
      </ul>

      {/*
        The part that must be read. Same size as the rest, in the body, above
        the button rather than under it.
      */}
      <p className="mt-3 text-[0.875rem] leading-6 text-slate-700">
        This is a free trial of Pro. It may be cancelled at any time in the future, and you can
        give it up yourself whenever you like, from your account page. If it ends, your account
        goes back to the free plan and everything you have written or practised stays where it is.
        You will never be charged without choosing to subscribe yourself.
      </p>

      {phase === "error" && (
        <p className="mt-3 text-[0.9375rem] leading-7 text-amber-800" role="alert">
          {message}
        </p>
      )}

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary" onClick={accept} disabled={busy}>
          {busy ? "Starting…" : "Start my free Pro trial"}
        </button>
        <button type="button" className="btn-secondary" onClick={dismiss} disabled={busy}>
          No thanks
        </button>
      </div>
    </section>
  );
}
