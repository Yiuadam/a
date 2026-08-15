"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { generateDisplayName, usernameFromEmail } from "@/lib/auth/generated-username";
import { publishProfileUpdate } from "./profileEvents";
import { useAccountProfile } from "./AccountProfileProvider";
import type { ProfileFields } from "./types";
import LoadingIndicator from "@/components/LoadingIndicator";

export default function AccountIdentityForm({ onboarding = false }: { onboarding?: boolean }) {
  const { profile } = useAccountProfile();
  if (!profile) return <p className="text-sm text-slate-500"><LoadingIndicator label="Loading identity…" /></p>;
  return <IdentityFields key={profile.username ?? ""} profile={profile} onboarding={onboarding} />;
}

function IdentityFields({ profile, onboarding }: { profile: ProfileFields; onboarding: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [displayName, setDisplayName] = useState(profile.displayName ?? "");
  /*
    An account that has never chosen a username starts from its own email
    address rather than blank — the owner's decision, and the one the server
    makes too when it has to choose (generatedCandidate in
    app/api/account/profile/route.ts), so the field shows what saving would
    actually do rather than leaving a learner to guess.

    Only ever a prefill. A username already chosen is never overwritten, and
    the field stays editable, which matters more here than usual: a username is
    public — it appears in the organisation team directory and works as a
    sign-in alias — so a learner who would rather not publish part of their
    address can simply type over it before saving.
  */
  const [username, setUsername] = useState(
    profile.username ?? usernameFromEmail(profile.email) ?? "",
  );
  const [birthDate, setBirthDate] = useState(profile.birthDate ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [generatedSuggestion, setGeneratedSuggestion] = useState(false);

  function returnDestination(): string {
    const requested = searchParams.get("returnTo") ?? "/";
    return requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";
  }

  function suggestDisplayName() {
    setDisplayName((current) => generateDisplayName(current || null));
    setGeneratedSuggestion(true);
    setError(null);
  }

  async function doLater() {
    if (busy) return;
    /*
      An unchanged username is an exit, whether or not its organisation-search
      copy has caught up. The replica condition used to be part of this test,
      which meant "Do this later" re-submitted into the very path that was
      failing and returned the learner to this screen with an error. The copy
      is repaired on the next profile read now, so there is nothing here worth
      holding somebody for.
    */
    if (profile.username && username === profile.username) {
      router.replace(returnDestination());
      router.refresh();
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const response = await authedFetch(apiUrl("/api/account/profile"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deferSetup: true,
          username,
          // Do later must always remain an exit. The server first tries the
          // visible suggestion (if valid), then generates on any collision or
          // malformed/reserved value rather than trapping the learner here.
          generateUsername: true,
        }),
      });
      const body = (await response.json().catch(() => null)) as (Partial<ProfileFields> & { error?: string }) | null;
      if (!response.ok || !body?.username) {
        setError(body?.error ?? "That didn't save. Please try again.");
        return;
      }
      publishProfileUpdate(body);
      router.replace(returnDestination());
      router.refresh();
    } catch {
      setError("Couldn't reach the server. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const response = await authedFetch(apiUrl("/api/account/profile"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName, username, birthDate }),
      });
      const body = (await response.json().catch(() => null)) as (ProfileFields & { error?: string }) | null;
      if (!response.ok || !body || !("displayName" in body)) {
        setError(body?.error ?? "That didn't save. Please try again.");
        return;
      }
      publishProfileUpdate(body);
      setSaved(true);
      if (onboarding) {
        router.replace(returnDestination());
        router.refresh();
      }
    } catch {
      setError("Couldn't reach the server. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-slate-700">Display name</span>
        {/*
          Generate lives here now rather than on the username. A display name
          is the field with nothing to satisfy — no shape rule, no uniqueness,
          no public handle — so an invented one costs a learner nothing and
          saves them the small awkwardness of naming themselves. The username
          below no longer needs the button at all: it arrives already filled
          in from the address they signed in with.
        */}
        <div className="relative">
          <input aria-describedby="account-display-name-help" className="input w-full !pr-28" required maxLength={60} autoComplete="name" placeholder="What we should call you" value={displayName} onChange={(event) => { setDisplayName(event.target.value); setGeneratedSuggestion(false); }} />
          <button type="button" onClick={suggestDisplayName} className="absolute inset-y-1.5 right-1.5 rounded-full border border-indigo-300/70 bg-indigo-50/75 px-3 text-xs font-semibold text-indigo-700 transition-colors hover:bg-indigo-100" aria-label={generatedSuggestion ? "Generate another display name" : "Generate a display name"}>
            {generatedSuggestion ? "Another" : "Generate"}
          </button>
        </div>
        <span id="account-display-name-help" className="text-xs leading-5 text-slate-500">What other people see. It does not have to be your real name.</span>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-slate-700">Username</span>
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-4 grid place-items-center text-slate-400">@</span>
          <input id="account-username" aria-describedby="account-username-help" className="input w-full !pl-9" required minLength={3} maxLength={30} pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,29}" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="your.name" value={username} onChange={(event) => setUsername(event.target.value.toLowerCase())} />
        </div>
        <span id="account-username-help" className="text-xs leading-5 text-slate-500">3–30 letters, numbers, dots, dashes or underscores. Taken from your email address — change it if you would rather not use that. Other people can see it.</span>
      </label>
      <label className="flex flex-col gap-1.5 sm:col-span-2 sm:max-w-sm">
        <span className="text-sm font-medium text-slate-700">Date of birth <span className="font-normal text-slate-500">(optional)</span></span>
        <input type="date" className="input" value={birthDate} onChange={(event) => setBirthDate(event.target.value)} />
        <span className="text-xs leading-5 text-slate-500">Only used to confirm you are 13 or over.</span>
      </label>
      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-800 sm:col-span-2">{error}</p>}
      {saved && !onboarding && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-800 sm:col-span-2">Your account identity is saved.</p>}
      {onboarding && <p className="text-xs leading-5 text-slate-500 sm:col-span-2 sm:text-right">Do this later saves the username above. If it is empty or unavailable, BandUp safely generates one for you.</p>}
      <div className="grid gap-2 sm:col-span-2 sm:flex sm:justify-end">
        {onboarding && <button type="button" className="btn-secondary w-full sm:w-auto" onClick={doLater} disabled={busy}>
          {busy ? <LoadingIndicator label="Saving username…" announce={false} /> : "Do this later"}
        </button>}
        <button type="submit" className="btn-primary w-full sm:w-auto" disabled={busy || !displayName.trim() || !username.trim()}>
          {busy ? <LoadingIndicator label="Saving…" announce={false} /> : onboarding ? "Finish account setup" : "Save identity"}
        </button>
      </div>
    </form>
  );
}
