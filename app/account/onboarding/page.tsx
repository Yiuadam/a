"use client";

import { Suspense } from "react";
import LoadingIndicator from "@/components/LoadingIndicator";
import Link from "next/link";
import AccountIdentityForm from "@/components/account/AccountIdentityForm";
import { useAccountProfile } from "@/components/account/AccountProfileProvider";

function Setup() {
  const { phase } = useAccountProfile();
  if (phase === "signed-out") {
    return <section className="card"><h1 className="text-xl font-semibold text-slate-900">Sign in first</h1><Link href="/account" className="btn-primary mt-4">Go to sign in</Link></section>;
  }
  if (phase === "loading") return <section className="card"><p className="text-sm text-slate-500"><LoadingIndicator label="Loading account setup…" /></p></section>;
  if (phase === "unavailable") return <section className="card"><h1 className="text-xl font-semibold text-slate-900">Account setup isn&rsquo;t reachable right now</h1><p className="mt-2 text-sm leading-6 text-slate-600">Nothing has been lost. Please check your connection and try again.</p></section>;

  return (
    <section className="card mx-auto max-w-3xl !rounded-[var(--radius-xl)]">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-indigo-700">Account setup</p>
      <h1 className="mt-1 text-[24px] font-semibold tracking-tight text-slate-900 sm:text-[30px]">Tell BandUp who you are</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Choose your display name and username now, or add your display name later. BandUp only needs a unique username before you continue—and will safely generate one if you skip without choosing one.</p>
      <div className="mt-5"><AccountIdentityForm onboarding /></div>
      <p className="mt-4 border-t border-slate-200 pt-3 text-xs leading-5 text-slate-500">Need to leave instead? <Link href="/account/close" className="font-medium text-indigo-700 underline underline-offset-2">Sign out or close your account</Link>.</p>
    </section>
  );
}

export default function AccountOnboardingPage() {
  return <Suspense fallback={<p className="px-5 py-10 text-sm text-slate-500"><LoadingIndicator label="Loading account setup…" /></p>}><Setup /></Suspense>;
}
