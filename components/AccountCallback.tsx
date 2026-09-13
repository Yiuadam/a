"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { errorFromFragment, saveSession, sessionFromFragment } from "@/lib/account";
import { consumeAuthReturnPath } from "@/lib/auth/return-path";
import LoadingIndicator from "@/components/LoadingIndicator";
import { apiUrl } from "@/lib/api";

/*
  Where Supabase drops the browser after a provider — or a recovery link — has
  done its part.

  The session arrives in the URL fragment, which is the one part of a URL that
  is never sent to a server: not to ours, not to Cloudflare's edge, and not in a
  Referer header to anything the next page loads. The job here is to take it
  out of the address bar quickly and put it somewhere the app can use.

  The fragment is read through useSyncExternalStore rather than in an effect,
  which is the same shape lib/store.ts uses for localStorage and for the same
  reason: it is browser state that does not exist during the server render, so
  it needs an explicit server snapshot instead of a first render that guesses
  and a second that corrects.

  That snapshot is "" — right for a bare URL, wrong for every other one —
  because the hydration render has to match what the server produced, and the
  server never saw the fragment at all. The effects below used to act on
  whatever render they saw first, which was that hydration render: an error,
  a session or an email link all read as "nothing here", and `fragment === ""`
  sent the browser on to a plain /account/ before the corrected render with
  the real hash ever arrived. `hydrated` below exists to give React that one
  extra render before either effect is allowed to decide anything.
*/

function subscribeToHash(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function readHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

function serverHash(): string {
  return "";
}

/*
  A hydration flag built the same way `fragment` is, rather than a useState
  flipped from inside a useEffect: React already knows how to give a
  component one extra render once the client snapshot is allowed to differ
  from the server one, and useSyncExternalStore is the primitive that says
  so — no setState-in-an-effect required, and nothing for the
  set-state-in-effect lint rule to object to.
*/
function subscribeOnce(): () => void {
  return () => {};
}

function hydratedOnClient(): boolean {
  return true;
}

function notYetHydrated(): boolean {
  return false;
}

/*
  Exported for the same reason errorFromFragment and sessionFromFragment in
  lib/account.ts are: it is the one piece of this screen's logic that a test
  can check without a browser, so it stays a pure function of the fragment
  rather than folded into the effect that acts on it.
*/
export function emailActionFromFragment(fragment: string): { token: string; action: "confirm" | "recover" } | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  const token = params.get("email_token");
  const action = params.get("email_action");
  if (!token || (action !== "confirm" && action !== "recover")) return null;
  return { token, action };
}

export default function AccountCallback() {
  const router = useRouter();
  const fragment = useSyncExternalStore(subscribeToHash, readHash, serverHash);

  const failure = errorFromFragment(fragment);
  const session = failure ? null : sessionFromFragment(fragment);
  const [emailFailure, setEmailFailure] = useState<string | null>(null);
  const emailAction = failure || session || emailFailure ? null : emailActionFromFragment(fragment);
  const emailToken = emailAction?.token ?? null;
  const emailActionName = emailAction?.action ?? null;

  /*
    False for exactly one render: the hydration one, where `fragment` above is
    still reporting serverHash() rather than the real one. Neither effect
    below may act before this flips, because both of them derive their
    decision from `fragment`, and on that first render `fragment` is a
    stand-in value rather than a reading of the URL.
  */
  const hydrated = useSyncExternalStore(subscribeOnce, hydratedOnClient, notYetHydrated);

  useEffect(() => {
    if (!hydrated || !emailToken || !emailActionName) return;
    let cancelled = false;
    void fetch(apiUrl("/api/auth/email/consume"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: emailToken, action: emailActionName }),
    }).then(async (response) => {
      const body = await response.json().catch(() => null) as {
        accessToken?: unknown;
        refreshToken?: unknown;
        expiresAt?: unknown;
        email?: unknown;
        error?: unknown;
      } | null;
      if (!response.ok || typeof body?.accessToken !== "string" || body.accessToken.length === 0) {
        throw new Error(typeof body?.error === "string" ? body.error : "That sign-in link could not be used.");
      }
      /*
        Saved before the cancellation check, not after: the token this request
        carried is already spent server-side the moment the response arrives,
        successful or not, so there is no version of "cancelled" in which
        declining to keep the session it bought helps anyone. Losing that race
        used to mean a one-time link that could never be used again and no
        session to show for it — the exact loop this ordering closes.
      */
      saveSession({
        accessToken: body.accessToken,
        refreshToken: typeof body.refreshToken === "string" ? body.refreshToken : null,
        expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : null,
        email: typeof body.email === "string" ? body.email : null,
      });
      if (cancelled) return;
      window.history.replaceState(null, "", window.location.pathname);
      router.replace(consumeAuthReturnPath("/"));
    }).catch((error: unknown) => {
      if (cancelled) return;
      const message = error instanceof Error ? error.message : "That sign-in link could not be used.";
      setEmailFailure(message.replace(/[<>]/g, "").slice(0, 200));
      window.history.replaceState(null, "", window.location.pathname);
    });
    return () => {
      cancelled = true;
    };
  }, [hydrated, emailToken, emailActionName, router]);

  useEffect(() => {
    if (!hydrated) return;

    /*
      `history.replaceState` rather than a redirect for the clearing step, so
      the URL carrying the token does not sit in session history behind a back
      button.
    */
    if (failure || emailFailure) {
      window.history.replaceState(null, "", window.location.pathname);
      return;
    }

    if (session) {
      saveSession(session);
      window.history.replaceState(null, "", window.location.pathname);
      router.replace(consumeAuthReturnPath("/"));
      return;
    }

    /*
      No token and no error. Usually someone opening this URL directly, or a
      link whose fragment was stripped in transit by a mail client that
      rewrites URLs. Neither is worth an alarming message, so it is treated as
      an ordinary arrival at the account page.

      fragment is trustworthy here specifically because of the `hydrated`
      guard above: this is never the hydration render, so "" means the URL
      really carried nothing rather than useSyncExternalStore still reporting
      its server snapshot.
    */
    if (fragment === "") router.replace("/account/");
  }, [hydrated, failure, emailFailure, session, fragment, router]);

  const shownFailure = failure ?? emailFailure;

  return (
    <div className="space-y-10">
      <div className="max-w-xl space-y-2">
        <h1 className="text-[1.625rem] font-semibold text-slate-900">
          {shownFailure ? "That didn’t work" : <LoadingIndicator label="Signing you in…" />}
        </h1>
        {shownFailure ? (
          <>
            <p className="text-[0.9375rem] leading-7 text-slate-600">{shownFailure}</p>
            <p className="pt-2 text-[0.9375rem] leading-7 text-slate-600">
              Nothing on your device has changed, and your practice is untouched.
            </p>
          </>
        ) : (
          <p className="text-[0.9375rem] leading-7 text-slate-600">
            One moment — finishing up and taking you back to your account.
          </p>
        )}
      </div>

      {shownFailure && (
        <section className="card">
          <Link href="/account/" className="btn-primary">
            Back to sign in
          </Link>
        </section>
      )}
    </div>
  );
}
