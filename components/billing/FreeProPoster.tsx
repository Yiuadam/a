"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  authedFetch,
  getServerSnapshot as getSessionServerSnapshot,
  getSnapshot as getSessionSnapshot,
  subscribe as subscribeSession,
} from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { TIERS } from "@/lib/billing/tiers";

/*
  The poster for the free Pro trial.

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

  localStorage is the right place for a dismissal and would be the wrong place
  for an entitlement. What is stored is "this person has seen the poster", and
  the worst a cleared browser can do with it is show the poster a second time.
  The grant itself is a database row resolved server-side, where clearing a
  browser can do nothing to it. Keeping the two apart is deliberate: the honest
  reason there is no server-side dismissal is that recording one would need a
  migration, and a migration cannot be previewed.

  ---------------------------------------------------------------------------
  Nothing here decides anything

  Whether the offer is available at all comes from /api/billing/promo, which
  resolved it server-side — including whether the database will even accept the
  row. Accepting posts to the same route, which re-establishes every condition
  from the session before it writes. Editing anything in this file in dev tools
  changes what is drawn and changes nothing about what is granted.
*/

/** Set when the reader has decided, either way. See the header for why here. */
const DISMISSED_KEY = "bandup.promo.free-pro.v1";

type Phase = "idle" | "offered" | "accepting" | "accepted" | "error";

function dismissedAlready(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) !== null;
  } catch {
    // Private browsing, or storage switched off. Drawing the poster once per
    // visit is a better failure than never drawing it.
    return false;
  }
}

function rememberDecision(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, new Date().toISOString());
  } catch {
    /* Nothing to do, and nothing worth telling the reader about. */
  }
}

export default function FreeProPoster() {
  const session = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionServerSnapshot,
  );
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    // A sign-out or a sign-in re-runs this. `alive` keeps the older answer from
    // landing last and drawing a poster for the previous account.
    let alive = true;
    /*
      The reset happens in the cleanup rather than here, so a signed-out or
      already-decided reader costs no render at all and the previous account's
      poster is cleared as the session changes.
    */
    const done = () => {
      alive = false;
      setPhase("idle");
    };
    if (!session || dismissedAlready()) return done;

    authedFetch(apiUrl("/api/billing/promo"))
      .then(async (res) => (res.ok ? ((await res.json()) as { offered?: boolean }) : null))
      .then((body) => {
        if (alive && body?.offered === true) setPhase("offered");
      })
      .catch(() => {
        /* No answer means no poster. Silence is the safe direction here. */
      });

    return done;
  }, [session]);

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

  const dismiss = useCallback(() => {
    rememberDecision();
    setPhase("idle");
  }, []);

  if (phase === "idle") return null;

  if (phase === "accepted") {
    return (
      <section className="card" aria-live="polite">
        <h2 className="text-[17px] font-semibold text-slate-900">Your free Pro trial has started</h2>
        <p className="mt-1.5 text-[15px] leading-7 text-slate-600">
          Your account is on Pro now. Nothing has been charged and no card has been asked for.
          You can see what you have used on your account page.
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
      <h2 className="text-[17px] font-semibold text-slate-900">Pro, free, if you want it</h2>
      <p className="mt-1.5 text-[15px] leading-7 text-slate-600">
        Pro is the plan for the weeks before your exam. We are giving it to every account for
        nothing. You do not have to pay, and you do not have to give a card.
      </p>

      <ul className="mt-4 space-y-1.5">
        {TIERS.pro.includes.slice(0, 4).map((line) => (
          <li key={line} className="flex gap-2.5 text-[15px] leading-6 text-slate-700">
            <span
              aria-hidden="true"
              className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-600"
            />
            {line}
          </li>
        ))}
      </ul>

      {/*
        The part that must be read. Same size as the rest, in the body, above
        the button rather than under it.
      */}
      <p className="mt-4 text-[15px] leading-7 text-slate-700">
        This is a free trial of Pro. It may be cancelled at any time in the future. If it ends,
        your account goes back to the free plan and everything you have written or practised stays
        where it is. You will never be charged without choosing to subscribe yourself.
      </p>

      {phase === "error" && (
        <p className="mt-3 text-[15px] leading-7 text-amber-800" role="alert">
          {message}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
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
