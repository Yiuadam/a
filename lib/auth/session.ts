import { assertServerOnly } from "./server-only";
import { accountsEnabled } from "./env";
import { userFromAccessToken, supabaseConfigured, type AuthedUser } from "./supabase";

/*
  Who is making this request?

  The scheme is a bearer token in the Authorization header, and only that. No
  cookies. That is a decision about iOS as much as about the web:

  - The iOS app is a static bundle served from capacitor://localhost inside a
    WebView, calling the deployed API on a different origin. A cookie set by
    that API is cross-site from the WebView's point of view, and modern
    SameSite defaults will not send it. A header always travels.
  - One scheme for both platforms means one code path to reason about, rather
    than a cookie path that is exercised on the web and a header path that is
    exercised only on a device nobody can test here.

  See ACCOUNTS.md, threat 6, including what could not be verified.
*/

const MODULE = "lib/auth/session.ts";

export type SessionUser = AuthedUser;

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

/**
 * Resolves the caller, or null if the request is anonymous.
 *
 * Anonymous is not an error. Phase 1 ships with no login at all, and phase 2
 * will roll login out gradually, so every path downstream has to work for a
 * caller with no account — metered by address instead of by identity.
 */
export async function getSessionUser(req: Request): Promise<SessionUser | null> {
  assertServerOnly(MODULE);
  if (!accountsEnabled() || !supabaseConfigured()) return null;

  const token = bearerToken(req);
  if (!token) return null;
  return await userFromAccessToken(token);
}
