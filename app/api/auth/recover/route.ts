import { NextResponse } from "next/server";
import { accountsEnabled } from "@/lib/auth/env";
import { supabaseConfigured, sendMagicLink } from "@/lib/auth/supabase";
import { callbackUrl } from "@/lib/auth/oauth";
import { logInternal, safeJsonError, MESSAGES } from "@/lib/auth/errors";

/*
  Account recovery: email a one-time sign-in link.

  ---------------------------------------------------------------------------
  The one response

  This route answers the same way whether the address is registered, not
  registered, or malformed enough to have been rejected upstream. That is not
  vagueness for its own sake — a recovery form that distinguishes the two is a
  tool for asking "does this person have a BandUp account?" about any address
  you like, one request at a time. For an app whose users are visibly studying
  for an immigration exam, membership is not a harmless thing to leak.

  The cost is that someone who mistypes their address is told the mail is on
  its way and then waits for a letter that will never arrive. The copy on the
  page carries that weight instead: it says the link is on its way *if the
  address has an account*, so the honest uncertainty is in front of the user
  rather than hidden behind an encouraging lie.
*/

export const dynamic = "force-dynamic";

/*
  Enough of a check to reject an obvious non-address without pretending to
  validate email, which cannot be done with a regular expression and does not
  need to be: the real check is whether a message arrives.
*/
function looksLikeEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 254 &&
    /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value)
  );
}

export async function POST(req: Request) {
  if (!accountsEnabled() || !supabaseConfigured()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const email = (body as { email?: unknown } | null)?.email;

  /*
    Note what this does *not* do: return early with a different status for a
    bad address. The answer below is the answer to everything, so a probe
    cannot separate "not an address" from "no such account" either.
  */
  if (looksLikeEmail(email)) {
    try {
      const origin = new URL(req.url).origin;
      const sent = await sendMagicLink(email.trim(), callbackUrl(origin));
      if (!sent) {
        // Includes the ordinary case of an address with no account, which
        // Supabase refuses because should_create_user is false. Logged at the
        // same level as a real failure because the two are not distinguishable
        // from here, and neither is worth waking anyone for.
        logInternal("auth/recover", new Error("magic link not sent"));
      }
    } catch (err) {
      logInternal("auth/recover", err);
      // Still falls through to the same response. An upstream outage is not
      // something to disclose on an unauthenticated endpoint.
    }
  }

  return NextResponse.json({ ok: true });
}

/*
  Any other method gets the same nothing as a wrong URL, rather than a 405 that
  confirms the path exists.
*/
export async function GET() {
  return safeJsonError(MESSAGES.accountUnavailable, 404);
}
