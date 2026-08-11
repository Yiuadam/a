"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  authedFetch,
  getServerSnapshot,
  getSnapshot,
  subscribe,
} from "@/lib/account";
import { apiUrl } from "@/lib/api";
import SignedOut from "@/components/account/SignedOut";
import ClearDeviceSection from "@/components/account/ClearDeviceSection";
import { HubMenu, type HubItem } from "@/components/HubMenu";
import { TIERS, type Tier } from "@/lib/billing/tiers";
import { IS_MOBILE_BUILD, WEB_HOME } from "@/lib/platform";
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
  will; an account exists to carry them between devices and to raise the limit
  on the AI features. The copy says that rather than implying a wall.

  ---------------------------------------------------------------------------
  Signed in, this is a menu

  It was four groups of cards in a column: profile, plan, sync, and the two
  buttons that delete things — 3049 pixels on a 390-wide phone. Every one of
  them was a true thing about the account, and stacking them is how the page
  got made, one true thing under the last.

  Nobody arrives here wanting all four. They arrive to change a picture, or to
  sign out, or to find out why a phone and a laptop disagree — and the page
  answered whichever it was somewhere in the middle of three answers to
  questions they had not asked. So each is its own screen now, and this page is
  the choice between them. What that costs is one tap for the thing you came
  for; what it buys is that you can see all four options at once and know which
  tap it is.

    The plan row goes straight to /pricing. That screen shows the current plan,
    every alternative and the subscribe/manage control together, so upgrading
    never requires stepping through the billing menu first.
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
    Signed out, this page is one thing: a sign-in form, and it gets a narrow
    column so the card ends where the form ends rather than stretching to
    1400px with its right half empty.
  */
  const signingIn = phase === "ready" && status?.enabled === true && !status.signedIn;

  return (
    <div className={`mx-auto w-full space-y-6 ${signingIn ? "max-w-lg" : "max-w-2xl"}`}>
      <div className="space-y-1.5">
        <h1 className="text-[22px] font-semibold tracking-tight text-slate-900 sm:text-[26px]">
          Your account
        </h1>
        {/*
          One sentence, not four. The long version explained what an account is
          for, which is the right thing to read when you are deciding — and the
          wrong thing on the screen of somebody who decided months ago.
        */}
        <p className="text-[14px] leading-6 text-slate-600">
          {signingIn
            ? "Optional — everything works without one. Signing in carries your progress between devices."
            : "Everything about you, and the account itself. Pick one."}
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
        <SignedIn status={status} email={session?.email ?? null} />
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

/** The tier's own name, and the raw value for anything not in the table. */
function planName(tier: string | null | undefined): string {
  if (!tier) return "Free";
  return Object.prototype.hasOwnProperty.call(TIERS, tier) ? TIERS[tier as Tier].name : tier;
}

function SignedIn({ status, email }: { status: AccountStatus; email: string | null }) {
  const items: HubItem[] = [
    {
      href: "/account/profile",
      title: "Your profile",
      detail: "Name, date of birth and picture",
      /*
        The address on the menu, because "which account am I in" is the single
        commonest reason to open this page and it should not cost a tap. Long
        addresses are left to truncate rather than shortened here — a cut in
        the middle of a domain reads as a different address.
      */
      value: email ?? undefined,
    },
    {
      href: "/account/sync",
      title: "Practice on other devices",
      detail: "Move your work between phone and laptop",
    },
    {
      href: "/account/close",
      title: "Sign out, or close the account",
      detail: "Leave this device, or leave BandUp",
    },
  ];

  /*
    The plan row is a link to /pricing. Pricing and billing do not exist in the
    iOS bundle — scripts/build-mobile.mjs removes them, because Apple requires
    digital content used inside an app to be sold through In-App Purchase and
    BandUp's answer is to sell nothing in the app at all. So on iOS the row is
    replaced by a sentence naming where subscriptions live, which is prose
    rather than a link and is the same thing the tutor screen says.

    Inserted second rather than pushed on the end: it belongs next to the
    profile, and tests/ios-no-purchase.test.mjs is what noticed the link was
    there in the first place.
  */
  if (!IS_MOBILE_BUILD) {
    items.splice(1, 0, {
      href: "/pricing",
      title: "Plans & pricing",
      detail: "Compare, subscribe or manage your plan",
      value: planName(status.tier),
    });
  }

  return (
    <>
      <HubMenu items={items} />
      {IS_MOBILE_BUILD && (
        <p className="mt-3 text-[13px] leading-5 text-slate-500">
          You are on {planName(status.tier)}. Subscriptions are managed on {WEB_HOME}, not in the
          app — anything you buy there works here straight away.
        </p>
      )}
    </>
  );
}
