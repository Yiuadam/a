"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { saveAccess } from "@/lib/access";
import { postJSON } from "@/lib/api";

/*
  The landing after Stripe.

  The session id in the URL is exchanged, once, for the token that actually
  unlocks the app — see app/api/billing/claim. Everything about that exchange
  can fail in ways the learner did not cause and cannot fix by trying harder,
  so a failure here says what to do next rather than only what went wrong: the
  money is taken, and the receipt email is the way back in.
*/

type State =
  | { status: "claiming" }
  | { status: "done" }
  | { status: "failed"; message: string };

function Claim() {
  const sessionId = useSearchParams().get("session_id") ?? "";
  // A link with no session id is already wrong at render time, so it is the
  // initial state rather than something an effect discovers.
  const [state, setState] = useState<State>(() =>
    sessionId
      ? { status: "claiming" }
      : { status: "failed", message: "This link is missing its checkout reference." },
  );
  // Effects run twice in development; the exchange is safe to repeat but there
  // is no reason to make Stripe answer the same question twice.
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !sessionId) return;
    started.current = true;

    postJSON<{ token: string; expiresIn: number }>("/api/billing/claim", { sessionId })
      .then(({ token, expiresIn }) => {
        saveAccess(token, expiresIn);
        setState({ status: "done" });
      })
      .catch((err: unknown) => {
        setState({
          status: "failed",
          message: err instanceof Error ? err.message : "Could not confirm that payment.",
        });
      });
  }, [sessionId]);

  if (state.status === "claiming") {
    return <p className="text-slate-600">Confirming your payment with Stripe…</p>;
  }

  if (state.status === "failed") {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50/60 p-5">
        <h2 className="text-base font-semibold text-slate-900">We could not unlock Plus yet</h2>
        <p className="mt-2 text-sm text-slate-700">{state.message}</p>
        <p className="mt-2 text-sm text-slate-600">
          If you have been charged, nothing is lost. Wait a moment and reload this page, or
          write to{" "}
          <a className="underline" href="mailto:hello@bandup.life">
            hello@bandup.life
          </a>{" "}
          with the receipt Stripe emailed you.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-5">
      <h2 className="text-base font-semibold text-slate-900">Plus is on</h2>
      <p className="mt-2 text-sm text-slate-700">
        Writing marking, the speaking examiner, generated tests and word lookup are unlocked on
        this device. Stripe has emailed your receipt.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          href="/practice/writing"
          className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-accent-fg shadow-sm transition-colors hover:bg-indigo-700"
        >
          Mark an essay
        </Link>
        <Link
          href="/pricing"
          className="rounded-xl border border-slate-300 bg-surface px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100"
        >
          Manage billing
        </Link>
      </div>
    </div>
  );
}

export default function CheckoutSuccessPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Thank you</h1>
      {/* useSearchParams needs a boundary it can suspend against while the
          client picks up the query string. */}
      <Suspense fallback={<p className="text-slate-600">Loading…</p>}>
        <Claim />
      </Suspense>
    </div>
  );
}
