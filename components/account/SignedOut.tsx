"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiUrl } from "@/lib/api";
import { saveSession } from "@/lib/account";
import { IS_MOBILE_BUILD } from "@/lib/platform";
import AppleSignIn from "./AppleSignIn";
import GoogleSignIn from "./GoogleSignIn";
import NativeGoogleSignIn from "./NativeGoogleSignIn";
import LoadingIndicator from "@/components/LoadingIndicator";
import { consumeAuthReturnPath } from "@/lib/auth/return-path";

/*
  Signing in, and the second door for people who cannot.

  Lifted out of AccountPanel unchanged when the account screen was split up.
  It belongs on its own because it is the one part of that screen a signed-in
  learner never sees, so keeping it in the same file meant every reading of the
  signed-in layout had to scroll past two provider logos and a recovery form
  first.
*/

/*
  Which providers this screen has a button for, and nothing about what those
  buttons look like.

  It used to draw both marks itself, because both buttons were plain links it
  owned. Neither is any more. Google's is rendered by Google's own script inside
  an iframe, and Apple's is now AppleSignIn.tsx, which has to own its own markup
  precisely because Apple specifies that button's appearance down to the colour
  — so the mark, the wording and the caveat about measuring them against the
  current guidelines all live there, next to the thing they describe.

  What is left here is the list, which together with the filter below it is the
  whole of what decides whether a provider is offered at all. The list says
  which providers have a button written for them; the filter says which of
  those this deployment, and this build, actually put on the screen.
*/
const PROVIDER_BUTTONS = [
  { id: "google" },
  { id: "apple" },
] as const;

export default function SignedOut({
  providers,
  onRecovered,
}: {
  providers: string[];
  onRecovered: () => void;
}) {
  const [showRecovery, setShowRecovery] = useState(false);
  /*
    Google in the app is a different button from Google on the website, and for
    a while it was no button at all.

    The website's is Google Identity Services, which renders itself by running
    a script from accounts.google.com and falls back to a full navigation. In a
    WKWebView that fallback is the whole problem: Capacitor cancels any
    top-level navigation off the app's own origin and hands the URL to Safari,
    so tapping it took the learner out of BandUp, signed them in on the website
    and returned them to an app that was still signed out. It was removed for
    that reason, with a note saying what putting it back would take —
    ASWebAuthenticationSession, a callback scheme in Info.plist, and a bridge
    handing the result to the web view.

    That is now built. GoogleSignInPlugin.swift presents the system's OAuth
    sheet and returns a signed ID token, which is the same thing the website's
    button produces and which /api/auth/google/token already accepts. So the
    app draws NativeGoogleSignIn instead, and only when the plugin is actually
    present: an app built before that work, or a browser, gets nothing rather
    than a button that cannot work.

    The 4.8 arithmetic changes with it. Offering Google means the app owes an
    equivalent private way in, and Sign in with Apple is the intended one —
    it is written and waiting on its server configuration. Until that is live
    the app is offering a third-party login without its counterpart, which is
    a submission risk rather than a runtime one, and it is written down in
    APPSTORE.md rather than left for review to find.
  */
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
        <h2 className="text-[1.0625rem] font-semibold text-slate-900">Sign in</h2>
        {/*
          The second half of that sentence is a promise about the buttons
          below it, so it is only made when there are any. In the app there
          are none — Google is filtered out above and Apple is dormant — and
          offering "an account you already have" with nothing underneath to
          use it with reads as something having failed to load.
        */}
        <p className="mt-1.5 text-[0.9375rem] leading-7 text-slate-600">
          {available.length > 0
            ? "With an email address and a password, or with an account you already have."
            : "With an email address and a password."}
        </p>

        <PasswordForm />

        {available.length > 0 && (
          <>
            {/*
              A rule with a word in it, rather than a second heading. The two
              halves of this card are two doors to the same place, and giving
              the lower one its own title made it read as a different subject.
            */}
            <div className="mt-5 flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-slate-200" />
              <span className="text-xs font-medium uppercase tracking-wide text-slate-400">or</span>
              <span className="h-px flex-1 bg-slate-200" />
            </div>

            <div className="mt-4 flex flex-col gap-3">
              {/*
                Google Identity Services talks directly to this page so Google
                names BandUp rather than the Supabase project. Apple stays a
                full navigation — its redirect is what carries the learner out
                and back — and AppleSignIn decides which of the two Apple routes
                that redirect goes to.
              */}
              {available.map(({ id }) =>
                id !== "google" ? (
                  <AppleSignIn key={id} />
                ) : IS_MOBILE_BUILD ? (
                  <NativeGoogleSignIn key={id} />
                ) : (
                  <GoogleSignIn key={id} />
                ),
              )}
            </div>
            <p className="mt-3 text-xs leading-5 text-slate-500">
              BandUp never sees the password on your {who} account — {who} confirms it&rsquo;s you
              and tells us nothing else beyond your email address.
            </p>
          </>
        )}
      </section>

      {/*
        The second door, at the size of a footnote.

        It was a full card with its own heading and two lines of explanation,
        which put it below the fold on a laptop — the worst place for the thing
        somebody looks for precisely because they are stuck. As one line it is
        visible without scrolling, and the explanation moves inside, where it is
        read by the people who open it rather than by everybody.
      */}
      <section className="card !py-3">
        {showRecovery ? (
          <>
            <h2 className="text-[0.9375rem] font-semibold text-slate-900">Email me a sign-in link</h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              A one-time link to the address on your account, for when you can&rsquo;t get into the
              account you signed up with.
            </p>
            <RecoveryForm onDone={onRecovered} />
          </>
        ) : (
          <p className="text-sm leading-6 text-slate-600">
            Can&rsquo;t get in?{" "}
            <button
              type="button"
              className="font-medium text-indigo-700 underline underline-offset-2"
              onClick={() => setShowRecovery(true)}
            >
              Email me a sign-in link
            </button>
          </p>
        )}
      </section>
    </div>
  );
}


/*
  Email and password, and for one account a name instead of an email.

  ---------------------------------------------------------------------------
  One box for both

  There is a single identifier field rather than a tab for "email" and a tab
  for "username", because the person typing already knows which one they have
  and does not need to tell the form. The server decides: anything with an @ is
  an address, anything else is checked against the one name this deployment
  knows. See lib/auth/env.ts.

  ---------------------------------------------------------------------------
  Why a wrong password says so little

  The server answers every failure the same way, so this cannot say more than
  it does — and it should not want to. What it can do is put the other doors
  right underneath the error, so somebody who signed up with Google and forgot
  finds the way in rather than a dead end.
*/
function PasswordForm() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || identifier.trim().length === 0 || password.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl("/api/auth/password"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: identifier.trim(),
          password,
          mode: creating ? "signup" : "signin",
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        confirm?: boolean;
        accessToken?: string;
        refreshToken?: string | null;
        expiresAt?: number | null;
        email?: string | null;
      };

      if (!res.ok) {
        /*
          A 404 means this deployment has no password sign-in wired up at all —
          the route answers the same nothing as a wrong URL, deliberately, and
          "Not found." is a sentence for whoever deployed the app rather than
          for the person looking at it. Everything else the server says here is
          already written for a learner, so it is passed through.
        */
        setError(
          res.status === 404
            ? "Signing in with a password isn't set up here yet. The other ways in still work."
            : (data.error ?? "That didn't work. Please try again."),
        );
        return;
      }
      if (data.confirm) {
        setConfirm(true);
        return;
      }
      if (typeof data.accessToken === "string" && data.accessToken.length > 0) {
        saveSession({
          accessToken: data.accessToken,
          refreshToken: data.refreshToken ?? null,
          expiresAt: data.expiresAt ?? null,
          email: data.email ?? null,
        });
        /*
          The client router, not a full document load. Only a server can turn
          a path into a page, and in the iOS app there is no server: the
          bundle is a static export served from capacitor://localhost, so
          handing window.location a route resolves to the bundle's root
          index.html. The learner signed in successfully and then landed on
          the home screen instead of the page the sign-in prompt interrupted
          — the return path was remembered correctly and thrown away by the
          navigation that was meant to honour it. On the website the same
          assignment worked only because a server was there to answer it.

          This was a full reload on the reasoning that half the app reads the
          session at mount and one reload beat waking half a dozen
          subscriptions by hand. That is no longer how the session is read:
          saveSession above emits to the store in lib/account.ts and the
          header, the tier and the sync all subscribe to it, so they wake
          themselves. router.refresh() covers whatever the server rendered,
          which is the pair GoogleSignIn.tsx already finishes on. Password was
          the last of the three ways in still doing this by hand: the Apple
          and sign-in-link route has always come back through
          AccountCallback.tsx, which router.replaces to the same remembered
          path and is why those two land correctly in the app already.
        */
        router.replace(consumeAuthReturnPath("/"));
        router.refresh();
        return;
      }
      setError("That didn't work. Please try again.");
    } catch {
      setError("Couldn't reach the server. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (confirm) {
    return (
      <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[0.9375rem] leading-7 text-emerald-800">
        Check your inbox — there is a link there that finishes setting up your account. If that
        address already had an account, use your existing password instead.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
      <div>
        <label htmlFor="signin-identifier" className="block text-sm font-medium text-slate-700">
          {creating ? "Email address" : "Email address or username"}
        </label>
        <input
          id="signin-identifier"
          type={creating ? "email" : "text"}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          className="input mt-1 w-full"
          placeholder="you@example.com"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
        />
      </div>

      <div>
        <label htmlFor="signin-password" className="block text-sm font-medium text-slate-700">
          Password
        </label>
        <input
          id="signin-password"
          type="password"
          autoComplete={creating ? "new-password" : "current-password"}
          required
          className="input mt-1 w-full"
          placeholder={creating ? "At least 8 characters" : "Your password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      {error && (
        <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm leading-6 text-rose-900">
          {error}
        </p>
      )}

        <button type="submit" className="btn-primary" disabled={busy}>
        {busy ? <LoadingIndicator label={creating ? "Creating…" : "Signing in…"} announce={false} /> : creating ? "Create account" : "Sign in"}
      </button>

      <p className="text-sm leading-6 text-slate-500">
        {creating ? "Already have one? " : "No account yet? "}
        <button
          type="button"
          onClick={() => {
            setCreating(!creating);
            setError(null);
          }}
          className="font-medium text-indigo-700 underline underline-offset-2"
        >
          {creating ? "Sign in instead" : "Create one with an email address"}
        </button>

      {creating && (
        <p className="rounded-xl border border-indigo-200 bg-indigo-50/55 px-3 py-2 text-xs leading-5 text-indigo-800">
          After your email is confirmed, you&rsquo;ll choose a unique username. You can add your display name then, or do it later.
        </p>
      )}
      </p>
    </form>
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
      <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[0.9375rem] leading-7 text-emerald-800">
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
    <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
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
        {sending ? <LoadingIndicator label="Sending…" announce={false} /> : "Send the link"}
      </button>
    </form>
  );
}
