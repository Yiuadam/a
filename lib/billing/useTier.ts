"use client";

import { useEffect, useSyncExternalStore } from "react";
import { authedFetch, getServerSnapshot, getSnapshot, subscribe, type Session } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { previewOnServer, readPreview, subscribePreview } from "./preview";
import { TIER_NAMES, tierAllows, type Feature, type Tier } from "./tiers";

/*
  What the browser knows about which tier it is in — which is to say, whatever
  the server last told it.

  ---------------------------------------------------------------------------
  This hook decides what to draw. It never decides what is allowed.

  Everything it returns came from /api/account/status, which resolved it from
  the database. The value is still only a copy in a place the user controls: a
  learner who edits it in dev tools changes what their own screen renders and
  changes nothing whatsoever about what the API will do, because every gated
  route asks `requireFeature` on the server before it does anything (see
  lib/billing/gate.ts). That is the whole division: this file is presentation,
  the gate is enforcement, and the second does not consult the first.

  So use it for the things a wrong answer makes ugly rather than unsafe —
  showing "Pro" next to a plan, drawing a padlock, not offering a button that
  would only come back refused. Do not use it to decide whether to send a
  request; send it, and let the server answer.

  ---------------------------------------------------------------------------
  Why it re-asks on sign-in and sign-out

  The tier belongs to an account, so the answer changes the moment the session
  does. Subscribing to the session store means a sign-out repaints the page as
  free without a reload, and — the case that actually bites — coming back from
  Stripe's checkout with a fresh session shows Pro rather than a stale Free
  until something else happens to remount the tree.

  ---------------------------------------------------------------------------
  Why a stall must not read as "loading" forever

  Every screen that gates on phase === "loading" — the paper tiles on the
  dashboard and on /practice among them (app/page.tsx, app/practice/page.tsx,
  components/TestChooser.tsx, components/SkillGate.tsx) — draws dimmed and
  unclickable for as long as this hook says "loading", and on a phone those
  tiles are the only way into a paper. A fetch with nothing to bound it can
  stay pending far longer than anyone will wait, so the request now carries
  its own limit: eight seconds, after which a stall is treated exactly like
  any other failure — "unavailable" rather than an indefinite "loading". See
  lib/entitlements/useSessions.ts, which already turns "unavailable" into an
  open shelf rather than a locked one.

  "unavailable" does not then sit forever either. The moment the browser
  reports it is back online, or this tab becomes visible again after being
  backgrounded, the hook asks once more on its own — both are the ordinary
  moments a stall actually clears, and neither should need a learner to go
  looking for a button. The button exists anyway, for every other reason a
  request can fail; `retry()` is what both it and the two automatic triggers
  call, and it is the same request the effect runs on mount, just asked for
  again.
*/

export type Phase = "loading" | "ready" | "unavailable";

/** One route's allowance, as /api/account/status reports it. */
export interface RouteUsage {
  route: string;
  /** What a learner calls it: "Word lookups", "Writing marked". */
  label: string;
  used: number;
  /** Null means no cap — the owner's own account. Zero means not on this plan. */
  quota: number | null;
  remaining: number | null;
}

export interface TierState {
  phase: Phase;
  /**
   * Null until the first answer arrives, and null forever when accounts are
   * off — there is no tier in that case, rather than a free one, and pretending
   * otherwise would have the pricing page ticking "your plan" on a system with
   * no plans in it.
   */
  tier: Tier | null;
  /** Whether accounts exist at all in this deployment. */
  accountsEnabled: boolean;
  signedIn: boolean;
  /** How long the window is, in seconds. A rolling 30 days. */
  windowSeconds: number;
  /**
   * When the oldest request in the window expires — not a reset day, because
   * the window rolls and there isn't one. Null when nothing is waiting to come
   * back. See supabase/migrations/0010_usage_detail.sql.
   */
  oldestAt: string | null;
  /**
   * One allowance per metered route, in a fixed order, including the routes
   * this tier has no allowance for. A zero quota is a fact worth drawing —
   * "not on your plan" — rather than a row to leave out.
   */
  routes: RouteUsage[];
  /** When the current access lapses, ISO, or null. */
  expiresAt: string | null;
  /**
   * Whether that date is a renewal or an ending.
   *
   * True for a card subscription — it charges again on that date. False for an
   * Alipay or WeChat Pay pass: one payment, and then the account goes back to
   * Free. Null when there is no date, or when the server could not establish
   * which it is, and a screen then prints the date without claiming either.
   *
   * Presentation only, like everything else in this hook. See the header.
   */
  renews: boolean | null;
}

const INITIAL: TierState = {
  phase: "loading",
  tier: null,
  accountsEnabled: false,
  signedIn: false,
  windowSeconds: 30 * 24 * 60 * 60,
  oldestAt: null,
  routes: [],
  expiresAt: null,
  renews: null,
};

/*
  The shape /api/account/status returns, as much of it as this file reads. Kept
  in step with that route by hand — a mismatch does not fail the build, it
  renders a confident wrong number, which is the failure this app can least
  afford. Every field is optional here because the flag-off response carries
  only `enabled`.
*/
interface AccountStatus {
  enabled?: boolean;
  signedIn?: boolean;
  tier?: string;
  unlimited?: boolean;
  usage?: {
    windowSeconds?: number;
    oldestAt?: string | null;
    routes?: RouteUsage[];
  };
  expiresAt?: string | null;
  renews?: boolean | null;
}

function readTier(value: unknown): Tier | null {
  return typeof value === "string" && (TIER_NAMES as readonly string[]).includes(value)
    ? (value as Tier)
    : null;
}

/*
  Eight seconds. Long enough that an ordinary slow connection still gets its
  answer; short enough that nobody is left looking at a dimmed paper tile for
  the length of a coffee break. There is nothing principled about the number
  beyond that — it only has to be *some* bound, because the failure mode this
  guards against is having none at all.
*/
const STATUS_TIMEOUT_MS = 8_000;

/*
  A single shared answer for every mounted consumer, not one useState per
  useTier() call.

  ---------------------------------------------------------------------------
  Why this exists: the request cap, not tidiness

  BandUp runs on the Cloudflare Workers Free plan — 100,000 requests per day
  for the entire site, and that cap has already taken bandup.life down twice.
  Before this store existed, every component that called useTier() — directly,
  or transitively through useSessionAccess() — held its own useState/useEffect
  and fired its own independent GET /api/account/status on mount. A single page
  could mount several of these at once (app/practice/writing/page.tsx alone
  has three: its own useTier(), and one useSessionAccess() each in SkillGate
  and TestChooser), so one visit multiplied one question into three or four
  identical ones. That is not a loop on its own, but it multiplies the cost of
  every mount, and it is exactly what turned the reload-loop incident into an
  outage 2-4x faster than the loop alone would have.

  So the fetch, and the answer, now live once at module scope — the same
  shape lib/account.ts already uses for the session itself (a cache, a
  listener set, subscribe/getSnapshot read through useSyncExternalStore) —
  and every hook instance reads the same cache and joins the same in-flight
  request rather than starting its own.

  ---------------------------------------------------------------------------
  Why the cache is keyed by session identity rather than fetched once and left

  The tier belongs to an account, and this is an entitlement surface: drawing
  a stale tier after somebody has signed out — or, worse, after a different
  account has signed in on the same tab — is a worse failure than one extra
  request. So the cache remembers which session's access token it answered
  for (`statusKey`, null for signed out), and the moment a hook instance sees
  a session whose identity does not match, it resets to INITIAL and fetches
  again — sign-in, sign-out and the cross-tab "storage" event lib/account.ts
  already relays all take this path, because all three change what `session`
  is, and this store's effect already depends on it.

  ---------------------------------------------------------------------------
  Why a generation counter instead of the old per-effect `alive` flag

  The single-instance version guarded a stale response with a boolean closed
  over by one effect: sign out re-ran the effect, the previous request's
  `alive` closure stayed false, and its late answer could not land. That
  guard cannot survive being shared — there is one fetch now, not one per
  mount — so `statusGeneration` plays the same role at module scope: every
  fresh authoritative request (a session change, or a forced retry) bumps it,
  and a response is only allowed to update the cache if the generation it
  started under is still current. A signed-out answer arriving after a
  subsequent sign-in has already started asking about someone else is
  dropped exactly the way the old flag dropped it — just shared.

  ---------------------------------------------------------------------------
  Why dedup needs both a cache check and an in-flight check

  `statusInFlight` is set synchronously the moment a fetch starts, before the
  first `await`. Two components mounting together both run their effect in
  the same synchronous pass, so the second one always sees `statusInFlight`
  already true (or, if the first request has already landed, sees a `"ready"`
  cache) and joins rather than starting a second request. The same guard
  covers the automatic retry triggers below: the browser's one "online" event
  fires every mounted instance's own listener, and without the guard that
  would be N retries, not one.
*/

let statusCache: TierState = INITIAL;
/**
 * The session identity (`accessToken`, or null when signed out) the cache
 * above currently answers for. `undefined` until the first request is ever
 * made, so that first request always runs even though the cache already
 * holds INITIAL.
 */
let statusKey: string | null | undefined;
let statusGeneration = 0;
let statusInFlight = false;
const statusListeners = new Set<() => void>();

function emitStatus(): void {
  for (const l of statusListeners) l();
}

/**
 * Exported, along with the two snapshot readers below, so tests can exercise
 * the shared cache directly the same way tests/account.test.mjs exercises
 * lib/account.ts's own subscribe/getSnapshot — this module has no rendered
 * tree for a test to mount, only the store.
 */
export function subscribeStatus(onChange: () => void): () => void {
  statusListeners.add(onChange);
  return () => statusListeners.delete(onChange);
}

export function getStatusSnapshot(): TierState {
  return statusCache;
}

export function getStatusServerSnapshot(): TierState {
  return INITIAL;
}

function sessionKey(session: Session | null): string | null {
  return session?.accessToken ?? null;
}

/**
 * Starts the one real network request. Every caller above this point has
 * already decided a fresh request is actually warranted.
 *
 * Takes no session argument: authedFetch reads the live session itself, at
 * the moment it is called, which is synchronously within the same call this
 * function makes — there is no gap in which it could have gone stale.
 */
function runStatusFetch(): void {
  const generation = ++statusGeneration;
  statusInFlight = true;

  authedFetch(apiUrl("/api/account/status"), { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) })
    .then(async (res) => {
      if (!res.ok) throw new Error("account status unavailable");
      return (await res.json()) as AccountStatus;
    })
    .then((body) => {
      // See the header: a superseded request's answer must not land.
      if (generation !== statusGeneration) return;
      statusCache = {
        phase: "ready",
        tier: body.enabled === true ? readTier(body.tier) : null,
        accountsEnabled: body.enabled === true,
        signedIn: body.signedIn === true,
        windowSeconds: body.usage?.windowSeconds ?? 30 * 24 * 60 * 60,
        oldestAt: body.usage?.oldestAt ?? null,
        routes: body.usage?.routes ?? [],
        expiresAt: body.expiresAt ?? null,
        /*
          `?? null` rather than defaulting to true or false. An older cached
          response carries no such field, and either sentence it chooses between
          would be a claim this build cannot support — so it prints neither.
        */
        renews: body.renews ?? null,
      };
      emitStatus();
    })
    .catch(() => {
      if (generation !== statusGeneration) return;
      /*
        Unreachable is reported as unreachable rather than defaulted to free.
        A page that quietly says "Free" when it could not ask would tell a
        paying subscriber they are not one, which is worse than saying
        nothing.

        accountsEnabled carries forward from whatever this store last knew
        rather than resetting to INITIAL's false. lib/entitlements/
        useSessions.ts reads that flag to tell a genuine outage (accounts
        exist, the answer just did not arrive) apart from accounts being off
        for this whole deployment, and folding both into "false" here was
        what made that distinction unreachable — every failure looked like
        the second thing, never the first.
      */
      statusCache = { ...INITIAL, accountsEnabled: statusCache.accountsEnabled, phase: "unavailable" };
      emitStatus();
    })
    .finally(() => {
      if (generation === statusGeneration) statusInFlight = false;
    });
}

/**
 * The one entry point every hook instance's effects call — on mount, on a
 * session change, and (with `force`) from `retryStatus`. Deciding whether a
 * request is actually needed lives here, once, rather than in each caller.
 */
function requestStatus(session: Session | null, force: boolean): void {
  const key = sessionKey(session);
  if (key !== statusKey) {
    // A different session (or the first one ever seen). Never trust a cached
    // answer that belonged to someone else — see the header.
    statusKey = key;
    statusCache = INITIAL;
    emitStatus();
    runStatusFetch();
    return;
  }
  if (statusInFlight) {
    // Somebody already asked; joining that request is the dedup this store
    // exists for. A forced retry still gets to flip the shared state
    // optimistic even though it does not get to start a second request.
    if (force && statusCache.phase !== "loading") {
      statusCache = { ...statusCache, phase: "loading" };
      emitStatus();
    }
    return;
  }
  if (!force && statusCache.phase === "ready") return; // the cache already answers this.
  statusCache = { ...statusCache, phase: "loading" };
  emitStatus();
  runStatusFetch();
}

/**
 * What every hook instance's mount/session-change effect calls. Exported for
 * the same reason as the snapshot readers above: it is what a test calls
 * twice in a row, with no session change in between, to prove that a second
 * consumer joins the first's in-flight request rather than starting its own.
 */
export function ensureStatus(session: Session | null): void {
  requestStatus(session, false);
}

/**
 * What the retry button, and the two automatic triggers below, call. Reads
 * the live session itself rather than trusting a closure, since this is a
 * shared, module-level action and not bound to whichever component happened
 * to render it.
 */
export function retryStatus(): void {
  requestStatus(getSnapshot(), true);
}

/** The current account's tier and allowance, as the server reports them. */
export function useTier(): TierState & { retry: () => void } {
  const session = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const state = useSyncExternalStore(subscribeStatus, getStatusSnapshot, getStatusServerSnapshot);

  useEffect(() => {
    ensureStatus(session);
  }, [session]);

  useEffect(() => {
    if (state.phase !== "unavailable") return;
    /*
      The two moments a stall actually clears on its own: the browser regains
      a connection, or this tab is looked at again after being backgrounded —
      the second covers a laptop that slept through the original request as
      well as an ordinary tab switch. Neither should need a learner to find
      the retry button themselves, so this asks for them.
    */
    const onOnline = () => retryStatus();
    const onVisibility = () => {
      if (document.visibilityState === "visible") retryStatus();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [state.phase]);

  return { ...state, retry: retryStatus };
}

/** One route's allowance, or null if the server has not reported it. */
export function usageFor(state: TierState, route: string): RouteUsage | null {
  return state.routes.find((r) => r.route === route) ?? null;
}

/**
 * Whether to *show* a feature as included. The server still decides whether it
 * runs — see the header, and lib/billing/gate.ts.
 */
export function tierShows(state: TierState, feature: Feature): boolean {
  return state.tier === null ? false : tierAllows(state.tier, feature);
}

/**
 * The tier to *draw*, which is the real one unless the owner is previewing
 * another.
 *
 * Only honoured for an admin — see lib/billing/preview.ts. A preview of "free"
 * paints the paywall on the owner's own screen while the server continues to
 * answer them as an admin, which is the point: it is the only way to look at
 * your own paywall without signing out.
 */
export function useDrawnTier(state: TierState): Tier | null {
  const preview = useSyncExternalStore(subscribePreview, readPreview, previewOnServer);
  if (state.tier !== "admin" || preview === null) return state.tier;
  return preview === "anonymous" ? "free" : preview;
}
