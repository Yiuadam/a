"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { authedFetch, getServerSnapshot, getSnapshot, subscribe } from "@/lib/account";
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
  /** When the current subscription lapses, ISO, or null. */
  expiresAt: string | null;
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
}

function readTier(value: unknown): Tier | null {
  return typeof value === "string" && (TIER_NAMES as readonly string[]).includes(value)
    ? (value as Tier)
    : null;
}

/** The current account's tier and allowance, as the server reports them. */
export function useTier(): TierState {
  const session = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [state, setState] = useState<TierState>(INITIAL);

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
        setState({
          phase: "ready",
          tier: body.enabled === true ? readTier(body.tier) : null,
          accountsEnabled: body.enabled === true,
          signedIn: body.signedIn === true,
          windowSeconds: body.usage?.windowSeconds ?? 30 * 24 * 60 * 60,
          oldestAt: body.usage?.oldestAt ?? null,
          routes: body.usage?.routes ?? [],
          expiresAt: body.expiresAt ?? null,
        });
      })
      .catch(() => {
        /*
          Unreachable is reported as unreachable rather than defaulted to free.
          A page that quietly says "Free" when it could not ask would tell a
          paying subscriber they are not one, which is worse than saying
          nothing.
        */
        if (alive) setState({ ...INITIAL, phase: "unavailable" });
      });

    return () => {
      alive = false;
    };
  }, [session]);

  return state;
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
