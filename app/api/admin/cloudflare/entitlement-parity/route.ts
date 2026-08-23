import { NextResponse } from "next/server";
import { accountsEnabled, isAdminEmail } from "@/lib/auth/env";
import { getSessionUser } from "@/lib/auth/session";
import { logInternal, safeJsonError } from "@/lib/auth/errors";
import { rpc, supabaseConfigured } from "@/lib/auth/supabase";
import { resolveEntitlementForParity, sameExpiry, type Entitlement } from "@/lib/billing/entitlements";
import { withCors } from "@/lib/http/cors";

/*
  The owner's proof that a D1 read of `billing_entitlement_runtime` would
  answer every account exactly as Supabase does today — not an assertion that
  it would, a resolved comparison for every account the directory has.

  This is item 7 of the pre-flip checklist described in the pull request that
  added it: zero mismatches, including trialists, paused trialists and
  admins, before `CLOUDFLARE_DATA_MODE_BILLING_ENTITLEMENT_RUNTIME` (or the
  learner-wide switch) is ever set to `cloudflare` or `read_cloudflare`.

  Every account is resolved through *both* backends regardless of what mode
  is currently configured — see `resolveEntitlementForParity` in
  lib/billing/entitlements.ts — so this tool works before the cutover is live
  and is exactly what proves it is safe to make live.
*/

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
/** Accounts examined per request. A caller wanting the whole directory pages through with `offset`. */
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
/** Concurrent per-account resolutions. Each one costs a Supabase RPC and a D1 query. */
const CONCURRENCY = 10;

interface AdminUserRow {
  id: string;
  email: string | null;
  total_count: number;
}

export interface EntitlementParityMismatch {
  id: string;
  email: string | null;
  supabase: Entitlement;
  cloudflare: Entitlement;
  /**
   * True when this account holds admin in Supabase (`profiles.role`, via
   * `resolve_entitlement`) but not in Cloudflare's answer — the one shape of
   * mismatch that means an account would lose admin, not merely resolve to a
   * different tier. See lib/billing/entitlements.ts for why that is expected
   * for any account still holding a database role that ADMIN_EMAILS does not
   * also name.
   */
  demotesAdmin: boolean;
}

interface EntitlementParityError {
  id: string;
  email: string | null;
  error: string;
}

async function pageOfUsers(offset: number): Promise<{ rows: AdminUserRow[]; total: number }> {
  const rows = await rpc<AdminUserRow[]>("admin_users_page", {
    p_query: "",
    p_limit: PAGE_SIZE,
    p_offset: offset,
  });
  return { rows, total: Number(rows[0]?.total_count ?? 0) };
}

function fieldsEqual(a: Entitlement, b: Entitlement): boolean {
  return a.tier === b.tier && a.source === b.source && sameExpiry(a.expiresAt, b.expiresAt);
}

async function handleGET(req: Request) {
  if (!accountsEnabled() || !supabaseConfigured()) return safeJsonError("Not found.", 404);
  const actor = await getSessionUser(req).catch(() => null);
  if (!actor || !isAdminEmail(actor.email)) return safeJsonError("Not found.", 404);

  const query = new URL(req.url).searchParams;
  const offset = Math.max(0, Number(query.get("offset")) || 0);
  const requested = Number(query.get("limit"));
  const limit = Number.isSafeInteger(requested) && requested > 0
    ? Math.min(requested, MAX_LIMIT)
    : DEFAULT_LIMIT;

  const mismatches: EntitlementParityMismatch[] = [];
  const errors: EntitlementParityError[] = [];
  let checked = 0;
  let total = 0;

  try {
    let cursor = offset;
    while (checked < limit) {
      const { rows, total: pageTotal } = await pageOfUsers(cursor);
      total = pageTotal;
      if (rows.length === 0) break;

      // Sliced to the caller's limit, which may cut a page short. `cursor`
      // always advances by exactly what was processed, never by a whole
      // page, so `nextOffset` below points at the first row *not* checked —
      // never past it, or a page's untested tail would be silently skipped.
      const batch = rows.slice(0, Math.max(0, limit - checked));
      for (let start = 0; start < batch.length; start += CONCURRENCY) {
        const slice = batch.slice(start, start + CONCURRENCY);
        const results = await Promise.all(slice.map(async (row) => {
          try {
            const pair = await resolveEntitlementForParity(row.id, row.email);
            return { row, pair, error: null as string | null };
          } catch (err) {
            return {
              row,
              pair: null,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }));
        for (const result of results) {
          checked += 1;
          if (result.error) {
            errors.push({ id: result.row.id, email: result.row.email, error: result.error });
            continue;
          }
          const { supabase, cloudflare } = result.pair!;
          if (!fieldsEqual(supabase, cloudflare)) {
            mismatches.push({
              id: result.row.id,
              email: result.row.email,
              supabase,
              cloudflare,
              demotesAdmin: supabase.tier === "admin" && cloudflare.tier !== "admin",
            });
          }
        }
      }

      cursor += batch.length;
      if (cursor >= total || batch.length < rows.length) break;
    }

    return NextResponse.json({
      checked,
      offset,
      nextOffset: cursor < total ? cursor : null,
      totalAccounts: total,
      mismatchCount: mismatches.length,
      mismatches,
      errorCount: errors.length,
      errors,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logInternal("admin/cloudflare/entitlement-parity", error);
    return safeJsonError("The entitlement parity check is unavailable right now.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
