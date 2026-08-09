import Stripe from "stripe";

/*
  The Stripe client, created once per server instance.

  `createFetchHttpClient` is used rather than the SDK's default Node HTTP
  client so the billing routes keep working on both deployment targets this
  repo supports: Vercel's Node runtime and the Cloudflare Worker produced by
  `npm run cf:build`, which has fetch but not Node's `http` module.

  The API version is deliberately not pinned here. The installed SDK pins the
  version it was written against, and overriding that with a string nobody has
  verified against this account is how a working integration breaks on deploy.
*/

let client: Stripe | null = null;

export const NO_STRIPE_MESSAGE =
  "Payments are not configured. Add STRIPE_SECRET_KEY to .env.local (see .env.example) and restart the server.";

export function hasStripeKey(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function stripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error(NO_STRIPE_MESSAGE);
  if (!client) {
    client = new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
  }
  return client;
}

/**
 * Where Stripe should send the learner back to.
 *
 * Checkout needs absolute URLs, and the app runs on localhost, on Vercel
 * preview domains and on bandup.life. Prefer an explicit setting, then the
 * origin of the request that asked for checkout, so previews return to the
 * preview rather than to production.
 */
export function siteUrl(req: Request): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) return configured.replace(/\/$/, "");
  try {
    return new URL(req.url).origin;
  } catch {
    return "http://localhost:3000";
  }
}
