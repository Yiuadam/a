import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/*
  The brief called this file middleware.ts. Next.js 16 deprecated that name and
  renamed the convention to proxy.ts — same feature, same semantics — so it is
  spelled the current way here. See node_modules/next/dist/docs/01-app/
  03-api-reference/03-file-conventions/proxy.md.

  It does two things, and deliberately not much else.

  1. It strips inbound headers that downstream code might one day be tempted to
     trust. Nothing reads these today. The point is that when phase 2 adds a
     header, it inherits a request whose trust headers cannot have been set by
     the caller — rather than someone having to remember.

  2. When accounts are switched on, it answers CORS preflights for the origins
     that are explicitly allowed, so the iOS build can send an Authorization
     header cross-origin. With the flag off, or with no origins configured,
     it grants nothing and the response is untouched.

  What it does not do is rate limiting. The docs are explicit that proxy code
  can run at the CDN edge and must not rely on shared modules or globals, which
  rules out any counter worth having. The meter lives in the database, where
  the count is correct across every instance — see lib/usage/guard.ts.

  In the iOS static export this file has no effect at all: an exported bundle
  has no server. Next prints a warning saying so during `npm run build:mobile`,
  which is expected and is not a failure.
*/

/** Headers a caller must never be able to set. Stripped unconditionally. */
const FORGEABLE = [
  "x-bandup-user-id",
  "x-bandup-role",
  "x-bandup-tier",
  "x-bandup-admin",
  "x-user-id",
  "x-user-role",
];

function accountsOn(): boolean {
  return process.env.ACCOUNTS_ENABLED === "1";
}

function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  const raw = process.env.ACCOUNTS_ALLOWED_ORIGINS;
  if (!raw) return null;
  const list = raw.split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);
  const normalised = origin.replace(/\/$/, "");
  // Exact match only. A prefix or suffix test is how an allowlist becomes a
  // way in for evil-bandup.example.
  return list.includes(normalised) ? normalised : null;
}

export function proxy(req: NextRequest) {
  const headers = new Headers(req.headers);
  for (const name of FORGEABLE) headers.delete(name);

  if (!accountsOn()) {
    return NextResponse.next({ request: { headers } });
  }

  const origin = allowedOrigin(req.headers.get("origin"));

  if (req.method === "OPTIONS" && origin) {
    return new NextResponse(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "600",
        // The allowed origin varies by request, so a cache must key on it.
        Vary: "Origin",
      },
    });
  }

  const res = NextResponse.next({ request: { headers } });
  if (origin) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Vary", "Origin");
  }
  return res;
}

// Scoped to the API. The pages are static and have nothing for this to do.
export const config = { matcher: "/api/:path*" };
