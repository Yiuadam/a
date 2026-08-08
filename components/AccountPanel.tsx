"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  authedFetch,
  clearSession,
  getServerSnapshot,
  getSnapshot,
  subscribe,
} from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { useMounted } from "@/lib/hooks";
import { syncProgress, lastSyncedAt, type SyncOutcome } from "@/lib/progress/sync";

/*
  The account screen, and the only place in the app where signing in happens.

  Three states, and the dullest one matters most: with ACCOUNTS_ENABLED unset —
  which is how this deploys until the backend is provisioned — the page says so
  plainly instead of showing buttons that lead nowhere. The flag is a server
  decision and is deliberately not a NEXT_PUBLIC_ variable, so the only way to
  learn it is to ask /api/account/status. That is one source of truth rather
  than two that can disagree.

  Everything here is optional by construction. The placement test, the study
  plan, every practice test and both drill sets work signed out and always
  will; an account exists to carry them between devices and to raise the daily
  allowance on the AI features. The copy says that rather than implying a wall.
*/

/*
  The shape /api/account/status actually returns. Kept in step with that route
  by hand — a mismatch here does not fail the build, it renders a confident
  wrong number, which is the failure this app can least afford.
*/
interface AccountStatus {
  enabled: boolean;
  /*
    Which sign-in buttons to draw. Comes from the server, which asks Supabase,
    so a provider that was never configured cannot get a button. Apple waits on
    an Apple Developer membership; until that exists the project reports Google
    alone and only Google is offered.
  */
  providers?: string[];
  signedIn?: boolean;
  tier?: string;
  unlimited?: boolean;
  usage?: {
    used: number;
    quota: number | null;
    remaining: number | null;
    windowSeconds: number;
  };
}

type Phase = "loading" | "ready" | "unavailable";

/*
  Provider marks.

  Both are drawn rather than fetched, because a cross-origin <img> on a page
  that may be cross-origin isolated is a needless dependency for two shapes
  this small. Nominative use in a sign-in button is what these marks are for,
  and it is what both companies' brand guidelines describe.

  Before submission, check the current guidelines: Google and Apple each
  specify permitted button heights, corner radii, minimum clear space and
  exact wording, and both revise them. What is here is faithful in shape and
  colour and has not been measured against either spec.
*/
function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true" className="shrink-0">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}

function AppleMark() {
  return (
    <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true" className="shrink-0">
      <path
        fill="currentColor"
        d="M12.32 9.53c-.02-1.86 1.52-2.76 1.59-2.8-.87-1.27-2.22-1.44-2.7-1.46-1.15-.12-2.24.68-2.83.68-.58 0-1.48-.66-2.43-.65-1.25.02-2.4.73-3.05 1.84-1.3 2.26-.33 5.6.93 7.43.62.9 1.35 1.9 2.31 1.86.93-.04 1.28-.6 2.4-.6s1.44.6 2.42.58c1-.02 1.63-.91 2.24-1.81.71-1.04 1-2.05 1.01-2.1-.02-.01-1.94-.75-1.96-2.97ZM10.5 3.87c.51-.62.86-1.48.76-2.34-.74.03-1.63.49-2.16 1.11-.47.55-.89 1.43-.78 2.27.83.07 1.67-.42 2.18-1.04Z"
      />
    </svg>
  );
}

export default function AccountPanel() {
  const session = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState<AccountStatus | null>(null);
  /*
    Bumped to ask the server again after something that could have changed the
    answer — currently only a recovery mail being requested. A counter rather
    than a callback so the fetch stays in one place with one cancellation rule.
  */
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    /*
      `alive` is not ceremony. Signing out re-runs this effect while the
      previous request is still in flight, and without the guard the older
      response lands last and repaints a signed-out page with signed-in
      figures.
    */
    let alive = true;

    authedFetch(apiUrl("/api/account/status"))
      .then(async (res) => {
        if (!res.ok) throw new Error("account status unavailable");
        return (await res.json()) as AccountStatus;
      })
      .then((body) => {
        if (!alive) return;
        setStatus(body);
        setPhase("ready");
      })
      .catch(() => {
        if (alive) setPhase("unavailable");
      });

    return () => {
      alive = false;
    };
  }, [session, reloadKey]);

  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

  const accountsOff = phase === "ready" && status?.enabled === false;

  return (
    <div className="space-y-10">
      <div className="max-w-xl space-y-2">
        <h1 className="text-[26px] font-semibold text-slate-900">Your account</h1>
        <p className="text-[15px] leading-7 text-slate-600">
          An account is optional. The placement test, your study plan, every practice test and
          both sets of drills work without one — signing in carries them between your phone and
          your laptop, and raises the daily limit on AI feedback.
        </p>
      </div>

      {phase === "loading" && (
        <section className="card">
          <p className="text-sm text-slate-500">Checking…</p>
        </section>
      )}

      {phase === "unavailable" && (
        <section className="card">
          <h2 className="text-[17px] font-semibold text-slate-900">
            Accounts aren&rsquo;t reachable right now
          </h2>
          <p className="mt-2 text-[15px] leading-7 text-slate-600">
            Everything else on BandUp still works — nothing about your practice depends on this
            page. Please try again in a minute.
          </p>
        </section>
      )}

      {accountsOff && <AccountsNotYetOpen />}

      {/*
        `signedIn` comes from the server, which is the only party that can tell
        whether a token is still good. Trusting the local copy instead would
        show an account screen to someone holding a revoked token, and every
        figure on it would be a guess.
      */}
      {phase === "ready" && status?.enabled === true && !status.signedIn && (
        <SignedOut providers={status.providers ?? []} onRecovered={reload} />
      )}

      {phase === "ready" && status?.enabled === true && status.signedIn === true && (
        <SignedIn status={status} email={session?.email ?? null} onSignOut={clearSession} />
      )}
    </div>
  );
}

/*
  The honest empty state. It is the one users will actually meet first, since
  the flag stays off until the Supabase project is provisioned and its RLS has
  been probed on the real database.
*/
function AccountsNotYetOpen() {
  return (
    <section className="card">
      <h2 className="text-[17px] font-semibold text-slate-900">Accounts aren&rsquo;t open yet</h2>
      <p className="mt-2 text-[15px] leading-7 text-slate-600">
        Sign-in is built but not switched on. Nothing you have done so far is affected: your
        placement result, plan and saved words are stored on this device and stay there.
      </p>
      <p className="mt-3 text-[15px] leading-7 text-slate-600">
        When accounts open you&rsquo;ll be able to sign in with Google or Apple, and your existing
        progress will be carried up to the account rather than replaced by it.
      </p>
      <p className="mt-4 text-sm text-slate-500">
        <Link href="/privacy" className="underline underline-offset-2 hover:text-slate-700">
          What BandUp stores, and what it doesn&rsquo;t
        </Link>
      </p>
    </section>
  );
}

const PROVIDER_BUTTONS = [
  { id: "google", label: "Continue with Google", Mark: GoogleMark },
  { id: "apple", label: "Continue with Apple", Mark: AppleMark },
] as const;

function SignedOut({
  providers,
  onRecovered,
}: {
  providers: string[];
  onRecovered: () => void;
}) {
  const [showRecovery, setShowRecovery] = useState(false);
  const available = PROVIDER_BUTTONS.filter((p) => providers.includes(p.id));

  /*
    Naming only what is actually on offer. Saying "Google and Apple" while
    showing one button reads as something being broken, and a learner who came
    here to use Apple deserves to be told it is not available rather than left
    hunting for the button.
  */
  const names = available.map((p) => (p.id === "google" ? "Google" : "Apple"));
  const who =
    names.length === 2 ? "Google and Apple" : names.length === 1 ? names[0] : "your provider";

  return (
    <div className="space-y-6">
      <section className="card">
        <h2 className="text-[17px] font-semibold text-slate-900">Sign in</h2>

        {available.length === 0 ? (
          <p className="mt-2 text-[15px] leading-7 text-slate-600">
            Signing in isn&rsquo;t available at the moment. Everything else on BandUp works as
            usual — your practice is stored on this device and is unaffected.
          </p>
        ) : (
          <p className="mt-2 text-[15px] leading-7 text-slate-600">
            Use the account you already have. BandUp never sees your password — {who} confirms
            it&rsquo;s you and tells us nothing else beyond your email address.
          </p>
        )}

        <div className="mt-5 flex flex-col gap-3 sm:max-w-sm">
          {/*
            Plain links, not fetch. The whole point of /api/auth/start is that
            it answers with a 302 to the provider, and a full navigation is
            what carries the user there and back. An XHR would follow the
            redirect and hand us HTML from Google that we could do nothing
            with.
          */}
          {available.map(({ id, label, Mark }) => (
            <a
              key={id}
              href={apiUrl(`/api/auth/start?provider=${id}`)}
              className="btn-secondary"
            >
              <Mark />
              {label}
            </a>
          ))}
        </div>
      </section>

      <section className="card">
        <h2 className="text-[17px] font-semibold text-slate-900">Lost access to those?</h2>
        <p className="mt-2 text-[15px] leading-7 text-slate-600">
          If you can&rsquo;t get into the account you signed up with, BandUp can email a
          one-time sign-in link to the address on your account instead.
        </p>

        {showRecovery ? (
          <RecoveryForm onDone={onRecovered} />
        ) : (
          <button
            type="button"
            className="btn-secondary mt-4"
            onClick={() => setShowRecovery(true)}
          >
            Email me a sign-in link
          </button>
        )}
      </section>
    </div>
  );
}

function RecoveryForm({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (sending || email.trim().length === 0) return;
    setSending(true);
    try {
      await fetch(apiUrl("/api/auth/recover"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
    } catch {
      // Deliberately ignored. The server answers the same way for every
      // outcome, so there is nothing this catch could tell the user that would
      // be true — and a network error here looks identical to success from the
      // one place it matters, which is their inbox.
    }
    setSending(false);
    setSent(true);
    onDone();
  }

  if (sent) {
    return (
      <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[15px] leading-7 text-emerald-800">
        {/*
          Says "if" on purpose. The server will not confirm whether an address
          has an account, because a form that does is a way to ask whether any
          given person uses this app. Better an honest conditional than a
          confident sentence that is sometimes false.
        */}
        If that address has a BandUp account, a sign-in link is on its way. It works once and
        expires after an hour.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="mt-4 flex flex-col gap-3 sm:max-w-sm">
      <label htmlFor="recovery-email" className="text-sm font-medium text-slate-700">
        Email address
      </label>
      <input
        id="recovery-email"
        type="email"
        autoComplete="email"
        required
        className="input"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <button type="submit" className="btn-primary" disabled={sending}>
        {sending ? "Sending…" : "Send the link"}
      </button>
    </form>
  );
}

function SyncCard() {
  const [state, setState] = useState<"idle" | "working" | SyncOutcome["status"]>("idle");
  /*
    Read during render rather than held in state. localStorage does not exist
    on the server, so a plain initial value would hydrate to a different
    string than it rendered with; useMounted is the codebase's answer to that
    and costs no effect. Re-reading after a sync happens for free, because
    setState above already re-renders this component.
  */
  const mounted = useMounted();
  const at = mounted ? lastSyncedAt() : null;

  async function run() {
    setState("working");
    const outcome = await syncProgress();
    setState(outcome.status);
  }

  return (
    <section className="card">
      <h2 className="text-[17px] font-semibold text-slate-900">Your practice on other devices</h2>
      <p className="mt-2 text-[15px] leading-7 text-slate-600">
        Syncing merges what is on this device with what is on your account, in both directions.
        Nothing is replaced and nothing is deleted — if you have practised on your phone and your
        laptop, you end up with both.
      </p>

      <button type="button" className="btn-primary mt-4" onClick={run} disabled={state === "working"}>
        {state === "working" ? "Syncing…" : "Sync now"}
      </button>

      {state === "done" && (
        <p className="mt-3 text-[15px] leading-7 text-emerald-800">
          Done. Your practice is on your account and on this device.
        </p>
      )}
      {state === "unavailable" && (
        <p className="mt-3 text-[15px] leading-7 text-slate-600">
          {/* Says plainly that nothing was lost, because that is the fear. */}
          That didn&rsquo;t work. Nothing has changed on this device — your practice is exactly
          where it was. Please try again in a minute.
        </p>
      )}
      {state === "signed-out" && (
        <p className="mt-3 text-[15px] leading-7 text-slate-600">
          Your session expired. Sign in again and this will work.
        </p>
      )}

      {at && (
        <p className="mt-3 text-sm text-slate-500">
          Last synced {new Date(at).toLocaleString()}
        </p>
      )}
    </section>
  );
}

function SignedIn({
  status,
  email,
  onSignOut,
}: {
  status: AccountStatus;
  email: string | null;
  onSignOut: () => void;
}) {
  const used = status.usage?.used ?? 0;
  const quota = status.usage?.quota ?? null;
  const unlimited = status.unlimited === true || quota === null;

  return (
    <div className="space-y-6">
      <section className="card">
        <h2 className="text-[17px] font-semibold text-slate-900">Signed in</h2>
        {email && <p className="mt-2 text-[15px] text-slate-600">{email}</p>}

        {/*
          Everything below is rendered from what the server said, and nothing
          is worked out here. A client that computes its own tier is a client
          that can be edited into a better one (ACCOUNTS.md, threat 1).
        */}
        <dl className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <dt className="text-xs uppercase tracking-wide text-slate-500">Plan</dt>
            <dd className="mt-1 text-[15px] font-medium text-slate-900">
              {status.tier ?? "Free"}
            </dd>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <dt className="text-xs uppercase tracking-wide text-slate-500">AI feedback today</dt>
            <dd className="mt-1 text-[15px] font-medium text-slate-900">
              {unlimited ? `${used} used — no limit` : `${used} of ${quota} used`}
            </dd>
          </div>
        </dl>

        <p className="mt-4 text-sm leading-6 text-slate-500">
          Practice tests, drills and your study plan don&rsquo;t count towards this and are never
          limited.
        </p>
      </section>

      <SyncCard />

      <section className="card">
        <h2 className="text-[17px] font-semibold text-slate-900">Sign out</h2>
        <p className="mt-2 text-[15px] leading-7 text-slate-600">
          Your practice stays on this device. Signing out ends the session — it doesn&rsquo;t
          delete your placement result, your plan or your saved words.
        </p>
        <button type="button" className="btn-secondary mt-4" onClick={onSignOut}>
          Sign out
        </button>
      </section>
    </div>
  );
}
