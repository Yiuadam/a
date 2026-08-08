"use client";

import { useState } from "react";
import { apiUrl } from "@/lib/api";

/*
  Signing in, and the second door for people who cannot.

  Lifted out of AccountPanel unchanged when the account screen was split up.
  It belongs on its own because it is the one part of that screen a signed-in
  learner never sees, so keeping it in the same file meant every reading of the
  signed-in layout had to scroll past two provider logos and a recovery form
  first.
*/

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

const PROVIDER_BUTTONS = [
  { id: "google", label: "Continue with Google", Mark: GoogleMark },
  { id: "apple", label: "Continue with Apple", Mark: AppleMark },
] as const;

export default function SignedOut({
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
            <a key={id} href={apiUrl(`/api/auth/start?provider=${id}`)} className="btn-secondary">
              <Mark />
              {label}
            </a>
          ))}
        </div>
      </section>

      <section className="card">
        <h2 className="text-[17px] font-semibold text-slate-900">Lost access to those?</h2>
        <p className="mt-2 text-[15px] leading-7 text-slate-600">
          If you can&rsquo;t get into the account you signed up with, BandUp can email a one-time
          sign-in link to the address on your account instead.
        </p>

        {showRecovery ? (
          <RecoveryForm onDone={onRecovered} />
        ) : (
          <button type="button" className="btn-secondary mt-4" onClick={() => setShowRecovery(true)}>
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
