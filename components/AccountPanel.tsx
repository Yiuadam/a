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
import GiveUpFreeProSection from "@/components/billing/GiveUpFreeProSection";
import { HubMenu, type HubItem } from "@/components/HubMenu";
import { TIERS, type Tier } from "@/lib/billing/tiers";
import ExternalPlansLink from "@/components/billing/ExternalPlansLink";
import { useExternalPlansUrl } from "@/lib/billing/storefront";
import { IS_MOBILE_BUILD, WEB_HOME } from "@/lib/platform";
import type { AccountStatus } from "@/components/account/types";
import LoadingIndicator from "@/components/LoadingIndicator";
import { lastSyncedAt, lastSyncFailed, subscribeSyncStatus } from "@/lib/progress/sync";

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

  It was four groups of cards in a column: profile, plan, sync controls, and
  the two buttons that delete things — 3049 pixels on a 390-wide phone. Every one of
  them was a true thing about the account, and stacking them is how the page
  got made, one true thing under the last.

  Nobody arrives here wanting every control at once. They arrive to change a
  picture, manage a plan or sign out, and the page answered whichever it was
  somewhere in the middle of several answers to questions they had not asked.
  So each remaining action is its own screen and this page is the choice between
  them. Progress sync is deliberately absent: it runs automatically whenever an
  account session is active and is not something a learner should have to manage.

    The plan row goes straight to /pricing. That screen shows the current plan,
    every alternative and the subscribe/manage control together, so upgrading
    never requires stepping through the billing menu first.
*/

type Phase = "loading" | "ready" | "unavailable";

const LOCAL_MENU_PREVIEW: AccountStatus = {
  enabled: true,
  signedIn: true,
  tier: "plus",
  usage: { windowSeconds: 0, oldestAt: null, routes: [] },
};

export default function AccountPanel({ localMenuPreview = false }: { localMenuPreview?: boolean }) {
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
    if (localMenuPreview) {
      return;
    }

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
  }, [session, reloadKey, localMenuPreview]);

  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

  const resolvedPhase = localMenuPreview ? "ready" : phase;
  const resolvedStatus = localMenuPreview ? LOCAL_MENU_PREVIEW : status;
  const accountsOff = resolvedPhase === "ready" && resolvedStatus?.enabled === false;

  /*
    Signed out, this page is one thing: a sign-in form, and it gets a narrow
    column so the card ends where the form ends rather than stretching to
    1400px with its right half empty.
  */
  const signingIn =
    resolvedPhase === "ready" && resolvedStatus?.enabled === true && !resolvedStatus.signedIn;

  return (
    <div className={`mx-auto w-full space-y-6 ${signingIn ? "max-w-lg" : "max-w-2xl"}`}>
      <div className="space-y-1.5">
        <h1 className="text-[1.375rem] font-semibold tracking-tight text-slate-900 sm:text-[1.625rem]">
          Your account
        </h1>
        {/*
          One sentence, not four. The long version explained what an account is
          for, which is the right thing to read when you are deciding — and the
          wrong thing on the screen of somebody who decided months ago.
        */}
        <p className="text-[0.875rem] leading-6 text-slate-600">
          {signingIn
            ? "Optional — everything works without one. Signing in carries your progress between devices."
            : "Everything about you, and the account itself. Pick one."}
        </p>
      </div>

      {resolvedPhase === "loading" && (
        <section className="card">
          <p className="text-sm text-slate-500"><LoadingIndicator label="Checking…" /></p>
        </section>
      )}

      {resolvedPhase === "unavailable" && (
        <section className="card">
          <h2 className="text-[1.0625rem] font-semibold text-slate-900">
            Accounts aren&rsquo;t reachable right now
          </h2>
          <p className="mt-2 text-[0.9375rem] leading-7 text-slate-600">
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
      {resolvedPhase === "ready" && resolvedStatus?.enabled === true && !resolvedStatus.signedIn && (
        <>
          <SignedOut providers={resolvedStatus.providers ?? []} onRecovered={reload} />
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

      {resolvedPhase === "ready" && resolvedStatus?.enabled === true && resolvedStatus.signedIn === true && (
        <SignedIn
          status={resolvedStatus}
          email={localMenuPreview ? "member@bandup.local" : session?.email ?? null}
          onPlanChanged={reload}
        />
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
      <h2 className="text-[1.0625rem] font-semibold text-slate-900">Accounts aren&rsquo;t open yet</h2>
      <p className="mt-2 text-[0.9375rem] leading-7 text-slate-600">
        Sign-in is built but not switched on. Nothing you have done so far is affected: your
        placement result, plan and saved words are stored on this device and stay there.
      </p>
      <p className="mt-3 text-[0.9375rem] leading-7 text-slate-600">
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

function SignedIn({
  status,
  email,
  onPlanChanged,
}: {
  status: AccountStatus;
  email: string | null;
  /* Giving the free Pro trial up changes the tier, and the plan row above shows
     it. Re-asking the server is the only way to redraw it truthfully. */
  onPlanChanged?: () => void;
}) {
  const externalUrl = useExternalPlansUrl();

  const items: HubItem[] = [
    {
      href: "/account/profile",
      icon: "profile",
      title: "Your profile",
      detail: "Name, birth date and photo",
      /*
        The address on the menu, because "which account am I in" is the single
        commonest reason to open this page and it should not cost a tap. Long
        addresses are left to truncate rather than shortened here — a cut in
        the middle of a domain reads as a different address.
      */
      value: email ?? undefined,
      valuePlacement: "below",
    },
    {
      href: "/account/close",
      icon: "exit",
      title: "Sign out, or close the account",
      detail: "Sign out here, or leave BandUp",
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
      icon: "plans",
      title: "Plans & pricing",
      detail: "Compare or manage your plan",
      value: planName(status.tier),
    });
  }

  return (
    <>
      <HubMenu items={items} />
      {IS_MOBILE_BUILD && (
        <p className="mt-3 text-[0.8125rem] leading-5 text-slate-500">
          You are on {planName(status.tier)}.{" "}
          {externalUrl ? (
            <>
              Subscriptions are managed on{" "}
              <ExternalPlansLink
                url={externalUrl}
                className="font-medium text-indigo-700 underline underline-offset-2"
              >
                {WEB_HOME}
              </ExternalPlansLink>
              , and anything you buy there works here straight away.
            </>
          ) : (
            <>
              Subscriptions are managed on {WEB_HOME}, not in the app — anything you buy there
              works here straight away.
            </>
          )}
        </p>
      )}
      {/*
        After the plan, because it is about the plan, and below the menu because
        it is one fact about this account rather than a way into another screen.
        It draws for almost nobody: only an account whose Pro comes from the free
        trial, resolved server-side, so a paying subscriber and the owner never
        see it. It is here rather than on /billing because /billing is not in the
        iOS bundle and the poster that offers the trial is — see the component.
      */}
      <GiveUpFreeProSection onChanged={onPlanChanged} />
      <SyncStatusLine />
    </>
  );
}

/*
  Progress sync itself has no control on this page — see the file header, it
  runs automatically and a learner should not have to manage it. But a sync
  that has been silently failing on every attempt is worse than one with no
  control at all, which is how cross-device sync going quietly wrong in
  production stayed undiagnosed. This reads the state autosync already leaves
  behind (lib/progress/sync.ts) rather than triggering anything of its own.

  A device that has never even attempted a sync renders nothing: that is the
  ordinary first moment after a brand-new sign-in, not a fault worth a line
  about. `useSyncExternalStore`'s server snapshot is a fixed `null`/`false`
  rather than `lastSyncedAt`/`lastSyncFailed` themselves, so the very first
  client render matches the server-rendered markup exactly and only repaints
  with the real, browser-only answer once mounted.
*/
function SyncStatusLine() {
  const at = useSyncExternalStore(subscribeSyncStatus, lastSyncedAt, () => null);
  const failed = useSyncExternalStore(subscribeSyncStatus, lastSyncFailed, () => false);

  if (at === null && !failed) return null;

  return (
    <p className="mt-3 text-[0.8125rem] leading-5 text-slate-500">
      {at ? `This device last synced ${friendlyWhen(at)}.` : "This device has not synced yet."}
      {failed
        ? " It could not sync just now — nothing here is lost, and it will try again automatically."
        : ""}
    </p>
  );
}

/** A short, human moment for a sync timestamp — plain enough for a status line. */
function friendlyWhen(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "recently";
  const elapsed = Date.now() - date.getTime();
  if (elapsed >= 0 && elapsed < 60_000) return "just now";
  if (elapsed >= 0 && elapsed < 3_600_000) return `${Math.max(1, Math.floor(elapsed / 60_000))}m ago`;
  if (elapsed >= 0 && elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `on ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(date)}`;
}
