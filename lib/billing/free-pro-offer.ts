"use client";

import {
  authedFetch,
  getSnapshot as getSessionSnapshot,
  subscribe as subscribeSession,
} from "@/lib/account";
import { apiUrl } from "@/lib/api";
import {
  consumeAutoAcceptIntent,
  dismissedAlready,
  rememberDecision,
} from "@/lib/billing/free-pro-dismissal";

/*
  Whether the free Pro trial is on offer, held apart from anything that draws it.

  ---------------------------------------------------------------------------
  Why this is not inside the poster any more

  It used to be: the poster mounted, asked /api/billing/promo whether this
  account was eligible, and — this is the part that matters — called
  `consumeAutoAcceptIntent()` in the same effect. That intent is how a guest who
  tapped "Sign up free" gets the trial without having to find the offer again
  and press a second button. It is read-and-cleared once.

  So the grant was a side effect of *rendering the poster*. Move the poster and
  the grant moves with it; put the offer somewhere that mounts lazily — a
  popover, say — and somebody who accepted the trial would simply not get it,
  with nothing on screen to say so. That is a silent loss of the thing the
  learner asked for, and it is the reason this file exists rather than the offer
  being passed around as a prop.

  Now the question "is it offered, and did somebody already accept" is answered
  once per session, in one place, by whatever is mounted — and every surface
  that draws the offer is a reader. Where the offer appears can change freely;
  what a learner is granted cannot.

  ---------------------------------------------------------------------------
  What is still decided elsewhere

  Everything that matters. Eligibility is resolved server-side per account and
  accepting posts to the same route, which re-establishes every condition from
  the session before it writes. This module caches an answer and remembers a
  dismissal; it cannot grant anything.
*/

export type FreeProState =
  /** Nothing asked yet, or nothing to ask about (a guest, or already dismissed). */
  | "unknown"
  /** The server said this account may take the trial. */
  | "offered"
  /** Asked, and the answer was no — or it was dismissed on this device. */
  | "none"
  | "accepting"
  | "accepted"
  | "error";

export interface FreeProOffer {
  state: FreeProState;
  /** Set only in `error`, and written for a learner rather than a log. */
  message: string;
}

let offer: FreeProOffer = { state: "unknown", message: "" };
const listeners = new Set<() => void>();

/* The session this answer belongs to, so a sign-out cannot leave the previous
   account's offer on screen. `null` means nothing has been asked yet. */
let askedFor: string | null = null;
let started = false;

function publish(next: FreeProOffer): void {
  offer = next;
  for (const listener of listeners) listener();
}

export function subscribeFreeProOffer(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getFreeProOffer(): FreeProOffer {
  return offer;
}

/* The server renders "nothing yet", always: the answer needs localStorage and
   a session, and neither exists during a server render. */
export function getFreeProOfferServerSnapshot(): FreeProOffer {
  return SERVER_SNAPSHOT;
}

const SERVER_SNAPSHOT: FreeProOffer = { state: "unknown", message: "" };

/**
 * Take the trial.
 *
 * Exported because two surfaces offer it and neither should own the request.
 * Idempotent enough to be safe under a double tap: a second call while one is
 * in flight returns the same promise's outcome rather than posting twice.
 */
export async function acceptFreePro(): Promise<void> {
  if (offer.state === "accepting" || offer.state === "accepted") return;
  publish({ state: "accepting", message: "" });
  try {
    const res = await authedFetch(apiUrl("/api/billing/promo"), { method: "POST" });
    const body = (await res.json().catch(() => null)) as
      | { granted?: boolean; error?: string }
      | null;
    if (res.ok && body?.granted === true) {
      /*
        Remembered here as well as granted on the server, so the offer stops
        being made on this device the moment it has been taken — the server
        stops offering it too, but the next render should not have to wait for
        a round trip to find that out.
      */
      rememberDecision();
      publish({ state: "accepted", message: "" });
      return;
    }
    publish({
      state: "error",
      message:
        typeof body?.error === "string" && body.error.length > 0
          ? body.error
          : "We couldn't start your free Pro trial just now. Please try again in a minute.",
    });
  } catch {
    publish({
      state: "error",
      message:
        "We couldn't reach the server. Please check your connection and try again in a minute.",
    });
  }
}

/** Turn the offer down on this device. */
export function dismissFreePro(): void {
  rememberDecision();
  publish({ state: "none", message: "" });
}

/**
 * Ask once, and keep asking whenever the session changes.
 *
 * Called from the app shell rather than from a component that draws the offer,
 * because the auto-accept continuation below has to run wherever the learner
 * happens to land after signing up — not only on the one screen that used to
 * carry the poster.
 */
export function startFreeProOffer(): () => void {
  if (started) return () => {};
  started = true;

  const check = () => {
    const session = getSessionSnapshot();
    const key = session ? "session" : "guest";
    if (askedFor === key) return;
    askedFor = key;

    /*
      A guest is offered the trial without asking anything: there is no account
      yet to be eligible. The surfaces render that case from the session alone.
    */
    if (!session) {
      publish({ state: dismissedAlready() ? "none" : "offered", message: "" });
      return;
    }
    if (dismissedAlready()) {
      publish({ state: "none", message: "" });
      return;
    }

    void authedFetch(apiUrl("/api/billing/promo"))
      .then(async (res) => (res.ok ? ((await res.json()) as { offered?: boolean }) : null))
      .then((body) => {
        /* Read-and-clear whatever the answer is: a guest who signed up gets one
           auto-continue, not one per reload of the same tab. */
        const autoAccept = consumeAutoAcceptIntent();
        if (body?.offered !== true) {
          publish({ state: "none", message: "" });
          return;
        }
        if (autoAccept) void acceptFreePro();
        else publish({ state: "offered", message: "" });
      })
      .catch(() => {
        /* No answer means no offer. Silence is the safe direction. */
        publish({ state: "none", message: "" });
      });
  };

  check();
  const unsubscribe = subscribeSession(() => {
    askedFor = null;
    check();
  });
  return () => {
    started = false;
    unsubscribe();
  };
}
