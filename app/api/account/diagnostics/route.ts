import { NextResponse } from "next/server";
import { accountsEnabled, adminEmails, adminUsername, isAdminEmail } from "@/lib/auth/env";
import { getSessionUser } from "@/lib/auth/session";
import { rpcDiagnostic, supabaseConfigured } from "@/lib/auth/supabase";
import { withCors } from "@/lib/http/cors";
import { USAGE_WINDOW_SECONDS, limitsForDatabase } from "@/lib/usage/limits";
import { hasApiKey } from "@/lib/anthropic";

/*
  What is actually wrong, for the one person entitled to know.

  ---------------------------------------------------------------------------
  Why this exists

  Every error this system shows a learner is deliberately uninformative. "The
  AI tutor is briefly unavailable" covers an unreachable database, a missing
  configuration, a rejected insert and an upstream outage, and that is correct:
  a stranger should not be able to map the inside of the app by provoking it.

  The cost is that the owner sees the same sentence, and has to guess. That
  cost has been paid twice now — a Worker variable silently dropped by a
  deploy, and a migration that had not been applied, both presenting as the
  same seven words. Guessing took hours each time and the answer was one line
  of text the server already knew.

  So the detail exists; it was simply never shown to anybody. This route shows
  it, to an admin session and to nothing else.

  ---------------------------------------------------------------------------
  What it costs to run

  One real call to `check_and_record_usage`, which records one usage row
  against the owner's own account. That is the point — a probe that avoided the
  failing call could not tell you whether the failing call works. The owner has
  no allowance to spend, so the row costs nothing but a line in the meter, and
  the response says so rather than leaving it to be discovered.

  ---------------------------------------------------------------------------
  What it deliberately does not do

  It does not fix anything, and it names no secret values — only whether each
  one is set. Knowing that ADMIN_EMAILS is empty is what makes the problem
  findable; knowing what is in it is not.
*/

export const dynamic = "force-dynamic";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function handleGET(req: Request) {
  /*
    404 rather than 403 for a non-admin. A 403 confirms the route exists and is
    worth attacking; a 404 says nothing at all, which is what somebody who is
    not the owner should learn from it.
  */
  if (!accountsEnabled() || !supabaseConfigured()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const user = await getSessionUser(req).catch(() => null);
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  add("Accounts switched on", accountsEnabled(), "ACCOUNTS_ENABLED");
  add("Supabase configured", supabaseConfigured(), "SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY");
  add("Anthropic key present", hasApiKey(), "ANTHROPIC_API_KEY — without it every AI route answers 503");
  add(
    "Owner address configured",
    adminEmails().length > 0,
    adminEmails().length > 0 ? `${adminEmails().length} address(es) in ADMIN_EMAILS` : "ADMIN_EMAILS is empty — you would sign in as an ordinary free account",
  );
  add(
    "Owner username configured",
    adminUsername() !== null,
    adminUsername() !== null ? "ADMIN_USERNAME is set" : "ADMIN_USERNAME is not set — optional; sign in with the address instead",
  );

  /*
    The three functions the app actually calls, in the order a request meets
    them. Named individually because "the database is broken" and "one function
    is missing" send you to completely different places.
  */
  const entitlement = await rpcDiagnostic("resolve_entitlement", { p_user_id: user.id });
  add("resolve_entitlement", entitlement.ok, entitlement.ok ? "answers" : `${entitlement.status}: ${entitlement.detail}`);

  const detail = await rpcDiagnostic("usage_detail", {
    p_user_id: user.id,
    p_window_seconds: USAGE_WINDOW_SECONDS,
  });
  add("usage_detail", detail.ok, detail.ok ? "answers — this is what draws the usage bar" : `${detail.status}: ${detail.detail}`);

  /*
    'chat' specifically, because usage_events carries an allowlist of route
    names and a deployment that has not applied 0007_chat_route.sql fails here
    and nowhere else. The insert happens before the decision, so the rejected
    row takes the whole call down and every /api/chat request answers 503.
  */
  const meter = await rpcDiagnostic("check_and_record_usage", {
    p_user_id: user.id,
    p_ip_hash: null,
    p_route: "chat",
    p_window_seconds: USAGE_WINDOW_SECONDS,
    p_limits: limitsForDatabase(),
  });
  add(
    "check_and_record_usage (route 'chat')",
    meter.ok,
    meter.ok
      ? "answers — one usage row was recorded against your account by this check"
      : `${meter.status}: ${meter.detail}` +
        (/usage_events_route_check|violates check constraint/i.test(meter.detail)
          ? " — apply supabase/migrations/0007_chat_route.sql"
          : ""),
  );

  return NextResponse.json({
    ok: checks.every((c) => c.ok),
    checks,
  });
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
