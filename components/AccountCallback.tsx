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

function emailActionFromFragment(fragment: string): { token: string; action: "confirm" | "recover" } | null {
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

  useEffect(() => {
    if (!emailToken || !emailActionName) return;
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
      if (cancelled) return;
      saveSession({
        accessToken: body.accessToken,
        refreshToken: typeof body.refreshToken === "string" ? body.refreshToken : null,
        expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : null,
        email: typeof body.email === "string" ? body.email : null,
      });
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
  }, [emailToken, emailActionName, router]);

  useEffect(() => {
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

      Guarded on the fragment being genuinely empty: during the very first
      client render useSyncExternalStore has not yet been given the real hash
      on some paths, and redirecting then would throw away a good session.
    */
    if (fragment === "") router.replace("/account/");
  }, [failure, emailFailure, session, fragment, router]);

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
