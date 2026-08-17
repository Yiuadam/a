import { NextResponse } from "next/server";
import { accountsEnabled, isAdminEmail } from "@/lib/auth/env";
import { getSessionUser } from "@/lib/auth/session";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { logInternal, safeJsonError } from "@/lib/auth/errors";
import { withCors } from "@/lib/http/cors";
import { requireBandUpCloudflareBindings } from "@/lib/cloudflare/bindings";
import {
  backfillCloudflareDomains,
  BACKFILL_DOMAINS,
  DEFAULT_BACKFILL_APPLY_LIMIT,
  isBackfillDomain,
  type BackfillDomain,
} from "@/lib/cloudflare/domain-backfill";
import { DEFAULT_DRIFT_ROW_LIMIT } from "@/lib/cloudflare/domain-drift";

/*
  Repairs the Supabase -> D1 mirror drift lib/cloudflare/domain-drift.ts names,
  by reading the current Supabase row and calling the same writers the live
  dual-write path uses. See lib/cloudflare/domain-backfill.ts for the full
  safety contract; this route is the one way to reach it from outside a
  script, gated exactly like /api/admin/cloudflare/readiness.

  GET never writes, regardless of query parameters — it always calls this
  with apply left false. POST also defaults to a dry run; it writes only when
  the body explicitly sends `apply: true`. Either verb answers with the same
  shape, so a script that only ever calls GET can preview it and one that
  calls POST can page through the same report while applying it.

  What this repairs: progress_snapshots, subscriptions, usage_events and
  ai_cost_events — the four domains named by the backfill that shipped this
  route. What it does NOT repair: profiles, usernames, provider_events and
  ai_cost_coverage drift (no writer is wired up for them here); any row D1
  holds that Supabase does not (missingInSource — reported, never acted on,
  Supabase is authoritative); a deleted or mid-deletion account's rows
  (skipped and reported by key, never written); and a domain's drift beyond
  `rowLimit` rows into the scan (the report says `driftComplete: false` and
  where it stopped rather than implying full coverage).
*/

export const dynamic = "force-dynamic";

async function owner(req: Request) {
  if (!accountsEnabled() || !supabaseConfigured()) return null;
  const actor = await getSessionUser(req).catch(() => null);
  return actor && isAdminEmail(actor.email) ? actor : null;
}

const notFound = () => safeJsonError("Not found.", 404);

function parseDomains(value: string | null): BackfillDomain[] {
  if (!value) return [...BACKFILL_DOMAINS];
  const wanted = value.split(",").map((part) => part.trim()).filter(isBackfillDomain);
  return wanted.length > 0 ? [...new Set(wanted)] : [...BACKFILL_DOMAINS];
}

function parseBound(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

/** Always a dry run: GET must never be able to write. */
async function handleGET(req: Request) {
  if (!(await owner(req))) return notFound();
  const query = new URL(req.url).searchParams;
  const domains = parseDomains(query.get("domain"));
  const rowLimit = parseBound(query.get("rowLimit"), DEFAULT_DRIFT_ROW_LIMIT, 200000);
  const applyLimit = parseBound(query.get("applyLimit"), DEFAULT_BACKFILL_APPLY_LIMIT, 200);

  try {
    const bindings = await requireBandUpCloudflareBindings();
    const domainReports = await backfillCloudflareDomains(domains, bindings, {
      apply: false,
      rowLimit,
      applyLimit,
    });
    return NextResponse.json(
      { apply: false, domains: domainReports },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    logInternal("admin/cloudflare/backfill/plan", error);
    return safeJsonError("Cloudflare drift backfill is unavailable right now.", 503);
  }
}

/**
 * Plans the same repair as GET, and applies it only when the body explicitly
 * asks: `{ apply: true }`. Any other body — empty, `apply: false`, malformed —
 * is treated as a dry run rather than rejected, so a mistaken or missing flag
 * can never cause a write.
 */
async function handlePOST(req: Request) {
  if (!(await owner(req))) return notFound();
  let body: { apply?: unknown; domains?: unknown; rowLimit?: unknown; applyLimit?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // An empty or invalid body is a dry run, not an error.
  }
  const apply = body.apply === true;
  const domains = Array.isArray(body.domains)
    ? [...new Set(body.domains.filter((value): value is string => typeof value === "string").filter(isBackfillDomain))]
    : [...BACKFILL_DOMAINS];
  const wanted = domains.length > 0 ? domains : [...BACKFILL_DOMAINS];
  const rowLimit = Number.isSafeInteger(body.rowLimit) && Number(body.rowLimit) > 0
    ? Math.min(Number(body.rowLimit), 200000)
    : DEFAULT_DRIFT_ROW_LIMIT;
  const applyLimit = Number.isSafeInteger(body.applyLimit) && Number(body.applyLimit) > 0
    ? Math.min(Number(body.applyLimit), 200)
    : DEFAULT_BACKFILL_APPLY_LIMIT;

  try {
    const bindings = await requireBandUpCloudflareBindings();
    const domainReports = await backfillCloudflareDomains(wanted, bindings, {
      apply,
      rowLimit,
      applyLimit,
      onError: (domain, key, error) => logInternal(`admin/cloudflare/backfill/${domain}/${key}`, error),
    });
    return NextResponse.json({ apply, domains: domainReports });
  } catch (error) {
    logInternal("admin/cloudflare/backfill/apply", error);
    return safeJsonError("Cloudflare drift backfill is unavailable right now.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
export const POST = withCors(handlePOST);
