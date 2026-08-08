"use client";

import { useEffect, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { errorFromFragment, saveSession, sessionFromFragment } from "@/lib/account";

/*
  Where Supabase drops the browser after a provider — or a recovery link — has
  done its part.

  The session arrives in the URL fragment, which is the one part of a URL that
  is never sent to a server: not to ours, not to Vercel's edge, and not in a
  Referer header to anything the next page loads. The job here is to take it
  out of the address bar quickly and put it somewhere the app can use.

  The fragment is read through useSyncExternalStore rather than in an effect,
  which is the same shape lib/store.ts uses for localStorage and for the same
  reason: it is browser state that does not exist during the server render, so
  it needs an explicit server snapshot instead of a first render that guesses
  and a second that corrects. It also keeps the effect below free of setState,
  so the whole component renders once and then acts.
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

export default function AccountCallback() {
  const router = useRouter();
  const fragment = useSyncExternalStore(subscribeToHash, readHash, serverHash);

  const failure = errorFromFragment(fragment);
  const session = failure ? null : sessionFromFragment(fragment);

  useEffect(() => {
    /*
      `history.replaceState` rather than a redirect for the clearing step, so
      the URL carrying the token does not sit in session history behind a back
      button.
    */
    if (failure) {
      window.history.replaceState(null, "", window.location.pathname);
      return;
    }

    if (session) {
      saveSession(session);
      window.history.replaceState(null, "", window.location.pathname);
      router.replace("/account/");
      return;
    }

    /*
      No token and no error. Usually someone opening this URL directly, or a
      link whose fragment was stripped in transit by a mail client that
      rewrites URLs. Neither is worth an alarming message, so it is treated as
      an ordinary arrival at the account page.

      Guarded on the fragment being genuinely empty: during the very first
      client render useSyncExternalStore has not yet been given the real hash
      on some paths, and redirecting then would throw away a good session.
    */
    if (fragment === "") router.replace("/account/");
  }, [failure, session, fragment, router]);

  return (
    <div className="space-y-10">
      <div className="max-w-xl space-y-2">
        <h1 className="text-[26px] font-semibold text-slate-900">
          {failure ? "That didn’t work" : "Signing you in…"}
        </h1>
        {failure ? (
          <>
            <p className="text-[15px] leading-7 text-slate-600">{failure}</p>
            <p className="pt-2 text-[15px] leading-7 text-slate-600">
              Nothing on your device has changed, and your practice is untouched.
            </p>
          </>
        ) : (
          <p className="text-[15px] leading-7 text-slate-600">
            One moment — finishing up and taking you back to your account.
          </p>
        )}
      </div>

      {failure && (
        <section className="card">
          <Link href="/account/" className="btn-primary">
            Back to sign in
          </Link>
        </section>
      )}
    </div>
  );
}
