/*
  CORS for the API, at the route rather than in front of it.

  This used to be proxy.ts. It was moved because Next.js 16 runs Proxy on the
  Node.js runtime and refuses `export const runtime` in that file — the docs
  say setting it throws — while OpenNext's Cloudflare adapter rejects Node
  middleware outright:

      ERROR Node.js middleware is not currently supported.

  So the choice was middleware or Cloudflare, and it could not be settled by
  configuration. The behaviour below is the same behaviour; only the place it
  runs has changed. Nothing about the app's behaviour is affected, because
  with ACCOUNTS_ENABLED unset both versions grant exactly nothing.

  What this deliberately does not do is rate limiting. A per-instance counter
  is not a limit — the meter lives in the database, where the count is correct
  across every instance. See lib/usage/guard.ts.
*/

function accountsOn(): boolean {
  return process.env.ACCOUNTS_ENABLED === "1";
}

/**
 * The request's origin, if it is one we have been told to allow.
 *
 * Exact match only. A `startsWith` or `endsWith` test is how an allowlist
 * becomes a way in for `evil-bandup.example`.
 */
export function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  const raw = process.env.ACCOUNTS_ALLOWED_ORIGINS;
  if (!raw) return null;
  const list = raw
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const normalised = origin.replace(/\/$/, "");
  return list.includes(normalised) ? normalised : null;
}

/**
 * Headers granting a cross-origin caller access, or nothing at all.
 *
 * `Vary: Origin` is not decoration. The answer differs per origin, so a cache
 * that ignored it could hand one caller's grant to another.
 */
export function corsHeaders(req: Request): Record<string, string> {
  if (!accountsOn()) return {};
  const origin = allowedOrigin(req.headers.get("origin"));
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  };
}

/**
 * The preflight answer. Exported as the OPTIONS handler of every API route.
 *
 * A disallowed origin gets 204 with no grant rather than an error: the browser
 * blocks the real request either way, and a distinct status would confirm to a
 * prober which origins are on the list.
 */
export function OPTIONS(req: Request): Response {
  if (!accountsOn()) return new Response(null, { status: 204 });

  const origin = allowedOrigin(req.headers.get("origin"));
  if (!origin) return new Response(null, { status: 204 });

  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      /*
        Keep this list in step with the route handlers. In particular, account
        progress sync uses PUT, profile edits use PATCH, and avatar removal
        uses DELETE. A Capacitor/WebView request for any of those methods is
        preflighted; omitting the method here makes the browser reject the
        request before it ever reaches BandUp.
      */
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    },
  });
}

/**
 * Wraps a route handler so its response carries the CORS grant.
 *
 * Applied to every API route. Adding a route without it is a route the iOS
 * build cannot call once accounts are on — which is why tests/cors.test.mjs
 * asserts that every route under app/api uses it.
 */
export function withCors<A extends unknown[]>(
  handler: (req: Request, ...args: A) => Promise<Response> | Response,
) {
  return async (req: Request, ...args: A): Promise<Response> => {
    const res = await handler(req, ...args);
    const headers = corsHeaders(req);
    for (const [key, value] of Object.entries(headers)) {
      res.headers.set(key, value);
    }
    return res;
  };
}
