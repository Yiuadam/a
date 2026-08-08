/*
  Headers a caller must never be able to set, and the rule that keeps them
  harmless.

  proxy.ts used to delete these from every inbound request before any route
  saw them. That was a runtime guarantee bought with middleware, and middleware
  is the thing that cannot run on Cloudflare (see lib/http/cors.ts). So the
  guarantee is made a different way.

  Deleting them was never the point. The point was that nobody downstream
  should ever trust a value the caller could have written. Stripping achieved
  that by making the values absent; a test that fails the build if any source
  file reads one of these names achieves it by making the mistake impossible to
  commit — and it catches the case stripping never could, which is a *new*
  forgeable header someone invents next month and reads two lines later.

  The enforcement is tests/trust-headers.test.mjs. This list is the input to
  it, and adding a name here is what puts a header under the rule.

  Note what is *not* in this list: `x-forwarded-for`. That one is read, on
  purpose, by lib/usage/ip.ts — because Cloudflare overwrites it at the edge
  with the real peer address. Its trustworthiness is a property of the
  deployment, and it is documented there rather than pretended away here.
*/

/** Trust claims a client could assert about itself. Never read these. */
export const FORGEABLE_HEADERS = [
  "x-bandup-user-id",
  "x-bandup-role",
  "x-bandup-tier",
  "x-bandup-admin",
  "x-user-id",
  "x-user-role",
] as const;

/**
 * A copy of the request's headers with every forgeable name removed.
 *
 * Provided for code that needs to pass headers onward — to an upstream call,
 * or into a logger — where a forged value would otherwise ride along. Reading
 * a specific header for a decision should not use this; it should not be
 * reading one of these at all.
 */
export function sanitizedHeaders(req: Request): Headers {
  const headers = new Headers(req.headers);
  for (const name of FORGEABLE_HEADERS) headers.delete(name);
  return headers;
}
