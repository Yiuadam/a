import { NextResponse } from "next/server";
import { accountsEnabled, adminEmails, adminUsername, isAdminEmail } from "@/lib/auth/env";
import { accountRuntimeEnabled } from "@/lib/auth/runtime";
import { getSessionUser, type SessionUser } from "@/lib/auth/session";
import { rpcDiagnostic, supabaseConfigured } from "@/lib/auth/supabase";
import { withCors } from "@/lib/http/cors";
import { LIMITS_SCHEMA_VERSION, USAGE_WINDOW_SECONDS } from "@/lib/usage/limits";
import { hasApiKey } from "@/lib/anthropic";
import { stripeDiagnostic, verifyCataloguePrices } from "@/lib/billing/stripe";
import { billingHealth } from "@/lib/billing/health";
import { CHECKOUT_CHECK_NAME } from "@/lib/billing/faults";
import { stripeConfigured } from "@/lib/billing/env";
import { nativeAuthCutoverActive } from "@/lib/cloudflare/native-auth-readiness";
import { googleOAuthServerFlowConfigured } from "@/lib/auth/google-oauth-server";
import { requireBandUpCloudflareBindings } from "@/lib/cloudflare/bindings";
import {
  cloudflareUsageDetail,
  currentCloudflareAccessGrants,
} from "@/lib/cloudflare/account-status";

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

  Nothing in the usage meter. This route is loaded automatically by the admin
  console, so a diagnostic that writes a real usage event turns page views into
  apparent learner demand. `usage_limits_schema` verifies the deployed meter
  shape without changing the figures the same console is trying to explain.

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

function diagnosticResponse(checks: Check[]) {
  return NextResponse.json({ ok: checks.every((check) => check.ok), checks });
}

/**
 * Once the legacy source is intentionally absent, diagnostics must not turn a
 * healthy native deployment into a false 404 merely because its old RPCs are
 * gone. These checks exercise the D1 identity, usage and entitlement readers
 * that native sessions use, then keep the same external Stripe configuration
 * checks the legacy panel already performs.
 */
async function nativeDiagnostics(user: SessionUser): Promise<NextResponse> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  add("Accounts switched on", accountsEnabled(), "ACCOUNTS_ENABLED");
  add("Cloudflare-native sign-in active", nativeAuthCutoverActive(), "CLOUDFLARE_NATIVE_AUTH with Cloudflare-only data authority");
  /*
    Checked here because its absence is invisible everywhere else. The website
    signs in with Google through the browser flow and never touches this, so
    the only symptom is inside the iOS app, where the button is replaced by
    "Google sign-in is being updated" — which reads as a passing outage rather
    than a key that was never set. GOOGLE_OAUTH_APP_ORIGIN lives in
    wrangler.jsonc and survives a deploy; the secret is the half that has to be
    put on the Worker by hand, so it is the half that goes missing.
  */
  add(
    "Google sign-in works in the iOS app",
    googleOAuthServerFlowConfigured(),
    googleOAuthServerFlowConfigured()
      ? "GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_OAUTH_APP_ORIGIN are both set"
      : "GOOGLE_OAUTH_CLIENT_SECRET is missing — the website's Google button still works, the app's does not. Set it with `npx wrangler versions secret put GOOGLE_OAUTH_CLIENT_SECRET`",
  );
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

  try {
    const bindings = await requireBandUpCloudflareBindings();
    const account = await bindings.db.prepare(`
      SELECT id FROM app_users WHERE id = ? AND deleted_at IS NULL
    `).bind(user.id).first<{ id: string }>();
    add("Cloudflare identity record", account?.id === user.id, account?.id === user.id
      ? "matches this authenticated owner session"
      : "the authenticated identity has no live D1 account record");

    await cloudflareUsageDetail(user.id, USAGE_WINDOW_SECONDS, bindings);
    add("Cloudflare usage ledger", true, "answers — this is what draws the usage bar");

    await currentCloudflareAccessGrants(user.id, bindings);
    add("Cloudflare entitlement ledger", true, "answers — this is what resolves the current access tier");
  } catch {
    add("Cloudflare account storage", false, "D1 identity, usage or entitlement data could not be read");
  }

  if (stripeConfigured()) {
    const health = await billingHealth();
    const broken = health.checks.filter((check) => !check.ok).map((check) => check.name);
    add(
      CHECKOUT_CHECK_NAME,
      health.ok,
      health.ok
        ? "learners can buy — native storage, key, Stripe answering, and all six prices match the catalogue"
        : `checkout is not ready. Failed: ${broken.join(", ")}`,
    );
    const stripe = await stripeDiagnostic();
    add("Stripe reachable", stripe.ok, stripe.detail);
  } else {
    add(
      "Stripe configured",
      false,
      "STRIPE_SECRET_KEY or every price id is missing — checkout is closed and the dashboard has no billing figures",
    );
  }
  return diagnosticResponse(checks);
}

async function handleGET(req: Request) {
  /*
    404 rather than 403 for a non-admin. A 403 confirms the route exists and is
    worth attacking; a 404 says nothing at all, which is what somebody who is
    not the owner should learn from it.
  */
  if (!accountsEnabled() || !accountRuntimeEnabled()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const user = await getSessionUser(req).catch(() => null);
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  if (nativeAuthCutoverActive() && !supabaseConfigured()) {
    return await nativeDiagnostics(user);
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
  /*
    The two functions the Stripe webhook calls, from 0009_billing_webhooks.sql.

    These are here because leaving them out cost an afternoon. Every other row
    on this panel was green while 0009 had not been applied, because nothing the
    panel checked touches it — and the failure it produces arrives at the worst
    possible moment: somebody's card is charged, Stripe records the
    subscription, and the webhook answers 503 forever, so the tier is never
    granted. From the outside that looks like the app losing a payment.

    `provider_customer_for_user` is checked with a real user id — the caller's
    own, which is the only one this route is allowed to ask about — because it
    is the one the billing portal button depends on.

    Both are also a reminder that a missing function is only half the failure.
    Supabase serves these through PostgREST, which keeps its own cache of what
    exists; a migration can apply cleanly and still 404 until the cache is told
    to reload. That happened twice on the day this panel was written, which is
    why the advice below names the reload as well as the file.
  */
  /*
    Called with the *real* argument list, and with an event that cannot match an
    account.

    The first version of this check called it with no arguments, on the theory
    that a function which exists answers 400 and one which does not answers 404.
    That was wrong, and wrong in the direction that matters: PostgREST resolves
    a function by the exact set of named arguments it was given, so "no such
    function" and "no overload with these arguments" are the same 404. The check
    reported a perfectly healthy database as broken.

    Passing the twelve real arguments fixes that and buys something better than
    an existence check: it exercises the same signature lib/billing/subscriptions.ts
    calls with, so a function that has drifted from the code is caught here too.

    It is safe to call. The function resolves the account before it claims
    anything — see the comment above `v_user_id := p_user_id` in
    0009_billing_webhooks.sql — and with no user id, no subscription id and no
    customer id there is nothing to resolve, so it returns 'unknown_user' having
    written nothing at all.
  */
  const applyFn = await rpcDiagnostic("apply_provider_subscription_event", {
    p_provider: "stripe",
    p_event_id: "diagnostic",
    p_event_at: new Date().toISOString(),
    p_payload: {},
    p_user_id: null,
    p_status: "canceled",
    p_tier: "free",
    p_customer_id: null,
    p_subscription_id: null,
    p_price_id: null,
    p_current_period_end: null,
    p_cancel_at_period_end: false,
  });
  const applyWorks = applyFn.ok && /unknown_user/.test(applyFn.detail);
  add(
    "apply_provider_subscription_event",
    applyWorks,
    applyWorks
      ? "answers — this is what the Stripe webhook writes through"
      : `${applyFn.status}: ${applyFn.detail}` +
        (/PGRST202|Could not find the function/i.test(applyFn.detail)
          ? " — apply supabase/migrations/0009_billing_webhooks.sql, then run" +
            " `notify pgrst, 'reload schema';`. Without it every Stripe webhook" +
            " answers 503 and a paid subscription is never granted"
          : ""),
  );

  const customerFn = await rpcDiagnostic("provider_customer_for_user", {
    p_user_id: user.id,
    p_provider: "stripe",
  });
  add(
    "provider_customer_for_user",
    customerFn.ok,
    customerFn.ok
      ? "answers — this is what opens the billing portal"
      : `${customerFn.status}: ${customerFn.detail}` +
        (/PGRST202|Could not find the function/i.test(customerFn.detail)
          ? " — apply supabase/migrations/0009_billing_webhooks.sql"
          : ""),
  );

  /*
    Which shape of allowances the database understands. Without
    0012_route_limits.sql the meter still answers and still records — it just
    refuses every AI request for every paying tier, because the application
    deliberately sends zeroes in the old keys rather than risk enforcing the
    wrong caps. That is the safe direction and an invisible one, so it is asked
    about directly.
  */
  const schema = await rpcDiagnostic("usage_limits_schema", {});
  // The body of a scalar RPC is the number itself, so it arrives in `detail`.
  const schemaVersion = schema.ok ? Number(schema.detail.trim()) : NaN;
  const schemaCurrent = Number.isFinite(schemaVersion) && schemaVersion >= LIMITS_SCHEMA_VERSION;
  add(
    "usage_limits_schema",
    schemaCurrent,
    schemaCurrent
      ? `answers ${schemaVersion} — per-route allowances are being enforced`
      : schema.ok
        ? `answers ${schema.detail.trim()}, but this build sends ${LIMITS_SCHEMA_VERSION} — apply supabase/migrations/0012_route_limits.sql`
        : `${schema.status}: ${schema.detail} — apply supabase/migrations/0012_route_limits.sql, or every paid tier is refused all AI`,
  );

  /*
    Stripe last, because it is the slowest and because everything above it is
    what the app needs to serve a page at all.

    It is here rather than left to the dashboard because the dashboard can only
    say "unavailable". An expired key, a restricted key that cannot read
    subscriptions, a test key against live prices and a network failure all
    look the same from a tile, and they are four different afternoons. This
    prints what Stripe said.
  */
  if (stripeConfigured()) {
    /*
      The verdict first, from the same aggregation the deploy workflow and the
      hourly watch call — lib/billing/health.ts. One source of truth for "can
      anybody buy anything", asked here with an admin session and asked there
      with none.

      This is the console's answer to 16 August. The site had been unable to
      take a single payment for an unknown number of days: the Stripe key had
      been rolled and this Worker never given the replacement, so every
      checkout died with `api_key_expired`. The learner saw the deliberately
      vague sentence, the reason sat in a Worker log nobody was tailing, and
      the owner found it by accident. A red banner across the top of the
      overview is what that morning was missing — and a failing line in a list
      of twenty would not have been it, which is why the overview singles this
      one check out by name.
    */
    const health = await billingHealth();
    const broken = health.checks.filter((c) => !c.ok).map((c) => c.name);
    add(
      CHECKOUT_CHECK_NAME,
      health.ok,
      health.ok
        ? "learners can buy — key, Stripe answering, and all six prices match the catalogue"
        : `no learner can start a checkout. Failed: ${broken.join(", ")}`,
    );

    /*
      And then what Stripe actually said, but only when something is wrong.

      The dashboard can only say "unavailable". An expired key, a restricted
      key that cannot read subscriptions, a test key against live prices and a
      network failure all look the same from a tile, and they are four
      different afternoons. This prints Stripe's own words for them.

      It is asked second, and only on a failure, so a healthy console costs one
      Stripe call rather than two — `billingHealth` has already made the same
      cheap request, and repeating it to fill in an explanation nobody needs
      would be spending the owner's rate limit on good news.
    */
    if (!health.ok) {
      const stripe = await stripeDiagnostic();
      add("Stripe reachable", stripe.ok, stripe.detail);

      /*
        And, when the prices are what failed, which of the six and how.

        The health check can only say `stripe_prices_match_catalogue: false`,
        because anyone may ask it. "One of your six prices is wrong" is a whole
        afternoon; "pro-yearly is archived" is a minute. This route has an admin
        session, so it may print the sentence.

        Only on a failure, and only when it is *this* check that failed — six
        Price reads are not worth spending to confirm good news, or to elaborate
        on an expired key that already explains everything below it.
      */
      if (health.checks.some((c) => c.name === "stripe_prices_match_catalogue" && !c.ok)) {
        for (const price of await verifyCataloguePrices()) {
          add(`Price ${price.plan}`, price.ok, price.detail);
        }
      }
    } else {
      add("Stripe reachable", true, "answers — the key this Worker holds is accepted");
    }
  } else {
    add(
      "Stripe configured",
      false,
      "STRIPE_SECRET_KEY or every price id is missing — checkout is closed and the dashboard has no billing figures",
    );
  }

  return diagnosticResponse(checks);
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
