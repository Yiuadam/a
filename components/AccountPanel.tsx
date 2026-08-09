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
import PlanSection from "@/components/account/PlanSection";
import ProfileSection from "@/components/account/ProfileSection";
import SignedOut from "@/components/account/SignedOut";
import ClearDeviceSection from "@/components/account/ClearDeviceSection";
import SyncSection from "@/components/account/SyncSection";
import { DeleteAccountSection, SignOutSection } from "@/components/account/DangerSection";
import type { AccountStatus } from "@/components/account/types";

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

  ---------------------------------------------------------------------------
  What this file is now, after the split

  It was eight hundred lines holding every card on the screen, and the two
  subjects a learner is most likely to come here for — who they are, and what
  they are paying for — were interleaved inside a single card headed "Signed
  in". Someone looking for their daily AI allowance read past a date of birth
  to find it.

  So the cards moved to components/account/ and what is left here is the shell:
  ask the server what is true, decide which of the three states to show, and
  lay the signed-in screen out as four labelled groups. Each group is one
  subject, each has a heading with a rule under it, and nothing in a group is
  about anything else:

    Your profile     name, date of birth, picture, the address you signed in with
    Your plan        tier, and today's AI allowance
    Your practice    carrying work between devices
    This account     signing out, and closing the account

  The behaviour is unchanged from before the split; only the arrangement and
  the headings are new.
*/

type Phase = "loading" | "ready" | "unavailable";

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

  /*
    Signed out, this page is one thing: a sign-in form. Signed in it is several
    — name, picture, sync, plan, deletion — and those want the full width the
    shell now gives them.

    Left in one column at both, the form sat against the left edge of a card
    stretched to 1400px, with the whole right half of the card empty. So the
    signed-out case gets its own narrow, centred column and the card ends where
    the form ends.
  */
  const signingIn = phase === "ready" && status?.enabled === true && !status.signedIn;

  return (
    /*
      Narrow and centred at both, and narrower still when it is only a form.

      Signed in this page is a column of short forms — a name, a picture, a
      plan, two buttons that delete things. Not one of them wants the 1500px
      the shell offers on a desktop, and stretched to it a 384px form sat
      against the left edge of a card with the whole right half of the card
      empty. A card should end where its contents end.
    */
    <div className={`mx-auto w-full space-y-10 ${signingIn ? "max-w-lg" : "max-w-2xl"}`}>
      <div className="max-w-xl space-y-2">
        <h1 className="text-[26px] font-semibold text-slate-900">Your account</h1>
        {/*
          Two sentences signed in, one signed out. The long version explains
          what an account is for, which is the right thing to read when you are
          deciding — but on the sign-in screen it is four lines above the only
          control on the page, and it pushed the recovery card off the bottom.
        */}
        <p className="text-[15px] leading-7 text-slate-600">
          {signingIn
            ? "Optional — everything works without one. Signing in carries your progress between devices."
            : "An account is optional. The placement test, your study plan, every practice test and both sets of drills work without one — signing in carries them between your phone and your laptop, and raises the daily limit on AI feedback."}
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
        <>
          <SignedOut providers={status.providers ?? []} onRecovered={reload} />
          {/*
            Shown signed out as well, and that is the case it matters most in:
            a visitor has every one of their scores in this browser and no
            account to delete them from. Offering the control only to people
            who have signed in would be offering it to everyone except the
            people whose data has nowhere else to live.
          */}
          <ClearDeviceSection />
        </>
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

/*
  One subject, one heading, one rule under it.

  The heading carries the topic so the cards beneath it do not have to repeat
  it — which is why a single-card group has no heading inside the card at all.
  Groups with more than one card keep an h3 on each, so the outline of the page
  still reads correctly with the cards collapsed.
*/
function Group({
  id,
  title,
  lead,
  children,
}: {
  id: string;
  title: string;
  lead: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id}>
      <div className="max-w-xl">
        <h2 id={id} className="heading-rule text-[20px] font-semibold text-slate-900">
          {title}
        </h2>
        <p className="mt-3 text-[15px] leading-7 text-slate-600">{lead}</p>
      </div>
      <div className="mt-5 space-y-5">{children}</div>
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
  return (
    <div className="space-y-12">
      <Group
        id="account-profile"
        title="Your profile"
        lead="Your picture, what BandUp calls you, and the address you signed in with."
      >
        <ProfileSection sessionEmail={email} />
      </Group>

      <Group
        id="account-plan"
        title="Your plan"
        lead="What you are on, and how much of today's AI feedback you have used."
      >
        <PlanSection status={status} />
      </Group>

      <Group
        id="account-practice"
        title="Your practice on other devices"
        lead="How your work moves between the phone and the laptop you study on."
      >
        <SyncSection />
      </Group>

      <Group
        id="account-close"
        title="This account"
        lead="Leaving this device, or leaving BandUp altogether."
      >
        <ClearDeviceSection />

        <SignOutSection onSignOut={onSignOut} />
        {/* Last on the page, because it is the one action that cannot be undone. */}
        <DeleteAccountSection onDeleted={onSignOut} />
      </Group>
    </div>
  );
}
