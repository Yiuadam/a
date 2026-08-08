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
    "Subscriptions aren't open yet. Everything on BandUp works in the meantime — practice tests, drills and your study plan are free and unlimited, and a free account raises the daily allowance on AI feedback.",

  /** Signed out, on a route that needs to know whose subscription it is. */
  signInFirst: "Please sign in first, so your subscription is attached to your account.",

  /** Anything that went wrong on our side while starting a checkout. */
  checkoutFailed:
    "We couldn't start the checkout just now. Nothing has been charged. Please try again in a minute.",

  /** The portal, for somebody who has never bought anything. */
  noSubscription: "There's no subscription on this account yet.",
} as const;
