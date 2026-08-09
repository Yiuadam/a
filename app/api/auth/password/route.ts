import { NextResponse } from "next/server";
import { accountsEnabled, emailForIdentifier } from "@/lib/auth/env";
import { callbackUrl } from "@/lib/auth/oauth";
import { logInternal, safeJsonError, MESSAGES } from "@/lib/auth/errors";
import { signInWithPassword, signUpWithPassword, supabaseConfigured } from "@/lib/auth/supabase";
import { clientIp } from "@/lib/usage/ip";
import { withCors } from "@/lib/http/cors";

/*
  Signing in with an email address and a password — and, for the owner, with a
  name instead of an address.

  ---------------------------------------------------------------------------
  Why this exists next to Google and Apple

  Because "use the account you already have" is a good default and a bad only
  option. It assumes a Google or Apple account, which is not universal in the
  countries this app is for; it routes a learner through a consent screen that
  names a third party; and it makes the owner's own sign-in depend on a
  provider being reachable. A password is the door that does not depend on
  anyone else.

  The trade is real and worth naming: BandUp now holds something that can be
  guessed. Everything below is about narrowing that.

  ---------------------------------------------------------------------------
  One answer for every failure

  Wrong password, no such address, an account that only has Google, a username
  this deployment does not know, GoTrue being down — all of them return the
  same 401 and the same sentence. Anything finer turns this form into a way to
  ask "does this person study for IELTS?", one address at a time, which for
  this audience is not a harmless question.

  The cost is that somebody who signed up with Google and then forgets is told
  their password is wrong rather than that they have not got one. The page copy
  carries that instead: it names the other doors right underneath.

  ---------------------------------------------------------------------------
  What the rate limit is, honestly

  It is per-isolate and in-memory. On Cloudflare that means an attacker who is
  spread across enough edge locations gets more attempts than the number below
  suggests, and a redeploy forgets everyone. It is real friction and it is not
  a wall, so it is not the only thing standing between a weak password and an
  account: GoTrue applies its own limits, and the owner's password is the one
  that most deserves to be long. Written here rather than in the usage table
  because that table is keyed by AI route and a failed login is not one — and
  because a limiter that needs the database is a limiter that stops working
  exactly when the database is the thing under load.
*/

export const dynamic = "force-dynamic";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

const attempts = new Map<string, number[]>();

function tooManyAttempts(key: string): boolean {
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  attempts.set(key, recent);

  /*
    Swept on write rather than on a timer: a Worker isolate can be frozen
    between requests, so anything scheduled may simply never run. The map only
    grows while requests are arriving, which is also the only time it matters.
  */
  if (attempts.size > 5000) {
    for (const [k, v] of attempts) {
      if (v.every((t) => now - t >= WINDOW_MS)) attempts.delete(k);
    }
  }

  return recent.length > MAX_ATTEMPTS;
}

/** Only counts against a caller when they got it wrong. */
function forgetAttempts(key: string): void {
  attempts.delete(key);
}

const WRONG = "That email address and password don't match an account.";

interface Body {
  identifier?: unknown;
  password?: unknown;
  mode?: unknown;
}

async function handlePOST(req: Request) {
  if (!accountsEnabled() || !supabaseConfigured()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  let body: Body | null;
  try {
    body = (await req.json()) as Body;
  } catch {
    body = null;
  }

  const identifier = typeof body?.identifier === "string" ? body.identifier.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const signingUp = body?.mode === "signup";

  if (identifier.length === 0 || identifier.length > 254 || password.length === 0) {
    return safeJsonError(WRONG, 401);
  }

  const key = clientIp(req) ?? "unknown";
  if (tooManyAttempts(key)) return safeJsonError(MESSAGES.rateLimited, 429);

  /*
    Resolved on the server, so a username never reaches Supabase and there is
    no second identity space to keep in step. Null means a name nobody here
    knows — answered as a wrong password, not as "no such user".
  */
  const email = emailForIdentifier(identifier);
  if (!email) return safeJsonError(WRONG, 401);

  if (signingUp) {
    /* An account is made from an address. A username is the owner's alias for
       one that already exists, so it is not a thing you can sign up as. */
    if (!identifier.includes("@")) return safeJsonError(WRONG, 401);
    if (password.length < 8) {
      return safeJsonError("Please choose a password of at least 8 characters.", 400);
    }

    let result;
    try {
      result = await signUpWithPassword(email, password, callbackUrl(new URL(req.url).origin));
    } catch (err) {
      logInternal("auth/password/signup", err);
      return safeJsonError(MESSAGES.accountUnavailable, 503);
    }

    if (result.outcome === "weak") {
      return safeJsonError("That password is too easy to guess. Please choose another.", 400);
    }
    if (result.outcome === "failed") {
      return safeJsonError(MESSAGES.accountUnavailable, 503);
    }
    if (result.outcome === "confirm" || !result.session) {
      /* Deliberately the same for "check your inbox" and "already has an
         account" — see signUpWithPassword. */
      return NextResponse.json({ confirm: true });
    }

    forgetAttempts(key);
    const s = result.session;
    return NextResponse.json({
      accessToken: s.accessToken,
      refreshToken: s.refreshToken,
      expiresAt: s.expiresIn ? Date.now() + s.expiresIn * 1000 : null,
      email: s.email,
    });
  }

  let session;
  try {
    session = await signInWithPassword(email, password);
  } catch (err) {
    logInternal("auth/password", err);
    return safeJsonError(WRONG, 401);
  }
  if (!session) return safeJsonError(WRONG, 401);

  forgetAttempts(key);
  return NextResponse.json({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.expiresIn ? Date.now() + session.expiresIn * 1000 : null,
    email: session.email,
  });
}

/** A wrong method gets the same nothing as a wrong URL. */
async function handleGET() {
  return safeJsonError(MESSAGES.accountUnavailable, 404);
}

export { OPTIONS } from "@/lib/http/cors";
export const POST = withCors(handlePOST);
export const GET = withCors(handleGET);
