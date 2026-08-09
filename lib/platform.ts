/*
  Which build this is.

  Apple requires digital content consumed inside an iOS app to be sold through
  In-App Purchase and takes 30% of it. BandUp's answer is the one Netflix and
  Kindle use: the iOS app sells nothing at all. There is no checkout in it, no
  price, no button and no link to one — so there is no in-app purchase to take
  a cut of, and nothing for review to reject.

  Two halves make that true, and both are needed:

    scripts/build-mobile.mjs moves /pricing and /billing out of the export, so
      the routes are not in the bundle at all rather than merely hidden;

    this flag stops the rest of the app pointing at them, because a link to a
      route that is not there is a broken link, and a "Subscribe" button in an
      iOS build is the thing review looks for.

  A subscription bought on the web works in the app immediately: entitlement is
  resolved server-side from the account (lib/billing/entitlements.ts), so the
  app only has to sign in.

  Adapted from lib/platform.ts on claude/stripe-ielts-integration-rd7dzv, which
  reached the same conclusion first.
*/

/**
 * True only in the static bundle that ships inside the iOS app.
 *
 * Set by scripts/build-mobile.mjs. NEXT_PUBLIC_ so it survives into the client
 * bundle — this decides what is drawn, so it has to be readable where the
 * drawing happens. It holds nothing secret: it is the string "1".
 */
export const IS_MOBILE_BUILD = process.env.NEXT_PUBLIC_MOBILE_BUILD === "1";

/**
 * Where a subscription is bought and managed. Named in prose, never linked
 * from the iOS build — a link out to a purchase page is the part Apple's
 * guidelines are actually about.
 */
export const WEB_HOME = "bandup.life";
