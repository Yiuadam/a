/*
  What a learner is told when something about payments does not work.

  The same rule lib/auth/errors.ts sets: say what the reader should do, and say
  nothing about how the server is built. None of these mentions Stripe, a key,
  a variable name or a status code, because none of that helps the person
  reading it and all of it helps somebody probing the deployment.

  They are collected here rather than written at each call site so that the
  three routes and the pricing page cannot drift into telling three different
  stories about the same condition.
*/
export const BILLING_MESSAGES = {
  /**
   * Checkout is not configured — no Stripe key, or no price behind any plan.
   * This is the state the app deploys in until somebody sets it up, so it is
   * written as a fact about the app rather than as an error, and the second
   * sentence is the part that matters: nothing a learner relies on is missing.
   */
  checkoutUnavailable:
    "Subscriptions aren't open yet. Everything on BandUp works in the meantime — every paper, every skill, unlimited, the moment you sign in.",

  /**
   * Checkout is closed — not because it was never set up, but because the
   * owner has deliberately paused it (BILLING_CLOSED, see lib/billing/env.ts).
   * A different sentence from checkoutUnavailable on purpose: "aren't open
   * yet" reads as though nobody had got round to it, which is not this fact.
   */
  billingClosed:
    "Subscriptions are paused for now. Everything on BandUp is free in the meantime — every paper, every skill, unlimited, the moment you sign in.",

  /**
   * Also the closed-shop fact, but for the moment somebody has just been
   * stopped by a paid feature rather than the moment they are comparing
   * plans — the upgrade panel under a lock, and the 402 a gated route
   * returns for the same reason (see upgradeMessage() in
   * lib/billing/gate.ts). Shorter than `billingClosed` above on purpose:
   * that sentence's job is to say what is still free while somebody reads
   * the pricing page, and this reader has already been told that. The one
   * new fact worth adding here is that the button they would have pressed
   * does not exist yet, not why, so the sentence stops there.
   */
  subscriptionsPaused: "Subscriptions are paused for now — this will open when they resume.",

  /** Signed out, on a route that needs to know whose subscription it is. */
  signInFirst: "Please sign in first, so your subscription is attached to your account.",

  /** Anything that went wrong on our side while starting a checkout. */
  checkoutFailed:
    "We couldn't start the checkout just now. Nothing has been charged. Please try again in a minute.",

  /** The portal, for somebody who has never bought anything. */
  noSubscription: "There's no subscription on this account yet.",
} as const;
