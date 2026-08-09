/*
  Which build this is.

  Apple requires digital content consumed inside an iOS app to be sold through
  In-App Purchase, so the iOS bundle must not offer a Stripe checkout — not a
  button, not a link, not a price. `scripts/build-mobile.mjs` keeps the billing
  routes and pages out of the static export altogether; this flag is what stops
  the rest of the app pointing at them.

  Until StoreKit exists, the iOS app is the free tier: placement, the bundled
  papers, the study plan, grammar and vocabulary. The AI features tell the
  learner where to find them rather than pretending they are broken.
*/
export const IS_MOBILE_BUILD = process.env.NEXT_PUBLIC_MOBILE_BUILD === "1";

/** Where to send someone who wants the paid features from inside the app. */
export const WEB_HOME = "bandup.life";
