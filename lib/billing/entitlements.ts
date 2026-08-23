import { isAdminEmail } from "@/lib/auth/env";
import { TIER_NAMES } from "./tiers";
import { assertServerOnly } from "@/lib/auth/server-only";
import { rpc } from "@/lib/auth/supabase";
import { domainReadsFromCloudflare } from "@/lib/cloudflare/cutover-domains";
import {
  resolveEntitlementFromCloudflare,
  type CloudflareRawEntitlement,
} from "@/lib/cloudflare/entitlement-runtime";
import type { Tier } from "./tiers";

/*
  The one function that answers "what is this user entitled to?".

  Everything that decides what a user may do reads this and nothing else. It
  takes a user id and consults the database; there is no parameter through
  which a caller can assert a tier, because a client asserting its own
  subscription is exactly the thing that must not work. See ACCOUNTS.md,
  threats 1 and 3.
*/

const MODULE = "lib/billing/entitlements.ts";

export type Role = "user" | "admin";

/*
  `Tier` is defined in ./tiers alongside what each tier costs and unlocks, and
  re-exported here so that everything already importing it from this module
  keeps working. The dependency runs that way round on purpose: ./tiers is
  imported by the pricing page, so it must stay free of anything that reaches a
  secret, and this file reaches one two hops down through lib/auth/supabase.ts.
*/
export type { Tier };

export interface Entitlement {
  role: Role;
  tier: Tier;
  /** Where the answer came from: which provider, or why there was none. */
  source: "anonymous" | "default" | "role" | "stripe" | "apple" | "promo";
  expiresAt: string | null;
}

/** What an unauthenticated or unresolvable caller gets: the least of it. */
export const ANONYMOUS_ENTITLEMENT: Entitlement = {
  role: "user",
  tier: "free",
  source: "anonymous",
  expiresAt: null,
};

interface RawEntitlement {
  role?: unknown;
  tier?: unknown;
  source?: unknown;
  expires_at?: unknown;
}

function normalise(raw: RawEntitlement | null): Entitlement {
  if (!raw) return ANONYMOUS_ENTITLEMENT;
  // Anything unrecognised degrades to the free tier rather than to a
  // permissive default. A typo in this file should cost a user their extras,
  // never hand out an unlimited allowance.
  const role: Role = raw.role === "admin" ? "admin" : "user";
  /*
    Any tier this build knows about is taken at face value; anything else falls
    to free. Written against TIER_NAMES rather than as a chain of comparisons
    because the chain was where the last tier was forgotten — adding "plus" to
    the catalogue and not here would have silently served every Plus subscriber
    the free tier, and nothing would have failed.
  */
  const tier: Tier =
    typeof raw.tier === "string" && (TIER_NAMES as readonly string[]).includes(raw.tier)
      ? (raw.tier as Tier)
      : "free";
  const source =
    raw.source === "role" ||
    raw.source === "stripe" ||
    raw.source === "apple" ||
    // The free Pro trial writes provider 'promo' on the subscription row, and
    // resolve_entitlement reports the provider as the source. Naming it here
    // keeps the owner's directory able to say where an entitlement came from
    // instead of reading every trial as an unexplained "default".
    raw.source === "promo" ||
    raw.source === "default" ||
    raw.source === "anonymous"
      ? raw.source
      : "default";
  return {
    role,
    tier,
    source,
    expiresAt: typeof raw.expires_at === "string" ? raw.expires_at : null,
  };
}

const CUTOVER_DOMAIN = "billing_entitlement_runtime";

/** What ADMIN_EMAILS grants, before either backend is asked anything. */
const ADMIN_ENTITLEMENT: Entitlement = { role: "admin", tier: "admin", source: "role", expiresAt: null };

async function resolveViaSupabase(userId: string): Promise<Entitlement> {
  const raw = await rpc<RawEntitlement | null>("resolve_entitlement", { p_user_id: userId });
  return normalise(raw);
}

/*
  D1 never supplies `role` — see lib/cloudflare/entitlement-runtime.ts for why
  that is correct rather than missing. `normalise` reads an absent `role` as
  "user", which is exactly right here: by the time this runs, the one way this
  build grants admin (ADMIN_EMAILS) has already been checked and has already
  said no.
*/
async function resolveViaCloudflare(userId: string): Promise<Entitlement> {
  const raw: CloudflareRawEntitlement = await resolveEntitlementFromCloudflare(userId);
  return normalise(raw);
}

/**
 * Resolves the entitlement for a user id, server-side, from the database.
 *
 * Throws if the database cannot be reached. The caller decides what an
 * unreachable database means — see `usageFailOpen` — because "assume free" and
 * "refuse the request" are different answers in different places.
 */
export async function resolveEntitlement(
  userId: string | null,
  email?: string | null,
): Promise<Entitlement> {
  assertServerOnly(MODULE);
  if (!userId) return ANONYMOUS_ENTITLEMENT;

  /*
    The owner, named in an environment variable rather than a database row.

    Promoting an account otherwise means opening a SQL editor and calling
    set_account_role, which is a fine thing to do once and a poor thing to
    require. This grants nothing new: whoever can set a Worker secret already
    holds SUPABASE_SERVICE_ROLE_KEY and could write the row by hand. It just
    spells it where the other secrets live.

    Checked before the database rather than after, so it works on the very
    first sign-in — there is no profile row to promote yet at that point, and
    an owner who has to sign in twice will reasonably think it is broken.

    The email comes from the verified session, never from the request body.

    This is also, deliberately, the *only* way this build grants admin.
    Postgres's `resolve_entitlement` still reads `profiles.role` first and
    would say otherwise for any account still holding a database-granted
    role — the D1 resolver never reads a role at all, by design (see
    lib/cloudflare/entitlement-runtime.ts) — so this check runs before either
    backend, and the two paths never even see an account this did not already
    rule out.
  */
  if (isAdminEmail(email)) return ADMIN_ENTITLEMENT;

  return domainReadsFromCloudflare(CUTOVER_DOMAIN)
    ? resolveViaCloudflare(userId)
    : resolveViaSupabase(userId);
}

/** One resolver's answer, paired with which one gave it. */
export interface EntitlementParityPair {
  supabase: Entitlement;
  cloudflare: Entitlement;
}

/**
 * Resolves one account through *both* backends, regardless of which one
 * `resolveEntitlement` is currently configured to trust.
 *
 * This exists for exactly one caller: the admin parity tool
 * (app/api/admin/cloudflare/entitlement-parity/route.ts) that is the owner's
 * pre-flip proof that the two answers agree — see the pull request that added
 * this for why "zero mismatches" is the standard rather than "looks right".
 *
 * The ADMIN_EMAILS check still runs first and short-circuits both sides
 * identically, exactly as it does in `resolveEntitlement` — an account it
 * grants admin to is never a source of a mismatch, because neither resolver
 * is ever asked about it. What *is* worth surfacing is the opposite case: an
 * account Supabase's `profiles.role` still calls 'admin' whose email is not
 * (or is no longer) in ADMIN_EMAILS. That account is not short-circuited, so
 * it reaches both resolvers — Supabase's RPC reports it 'admin' regardless of
 * ADMIN_EMAILS, the Cloudflare resolver never can — and the pair disagrees.
 * That disagreement is this tool's whole point: it is how the owner learns,
 * before flipping anything, exactly which accounts a role-based admin retired
 * in favour of ADMIN_EMAILS.
 */
export async function resolveEntitlementForParity(
  userId: string,
  email: string | null,
): Promise<EntitlementParityPair> {
  assertServerOnly(MODULE);
  if (isAdminEmail(email)) return { supabase: ADMIN_ENTITLEMENT, cloudflare: ADMIN_ENTITLEMENT };

  const [supabase, cloudflare] = await Promise.all([
    resolveViaSupabase(userId),
    resolveViaCloudflare(userId),
  ]);
  return { supabase, cloudflare };
}

/*
  The same instant, spelled two ways, is not a mismatch.

  Supabase's RPC returns Postgres's own timestamptz rendering
  (`2027-08-11T16:22:20+00:00`, no fractional digits when there are none);
  `resolveEntitlementFromCloudflare` passes D1's `current_period_end` straight
  through at its stored nine-digit precision (`2027-08-11T16:22:20.000000000Z`).
  A raw string compare flagged every account with a live expiry as drifted —
  found against real production data, where it was the only mismatch left
  once the promo-trial backfill landed. The same shape of fault `parityClock`
  (lib/cloudflare/source-clock.ts) exists to fix in the migration
  fingerprints; this one needed its own copy because it compares live
  entitlements, not fingerprinted evidence rows.
*/
export function sameExpiry(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const parsedA = Date.parse(a);
  const parsedB = Date.parse(b);
  // An unparseable timestamp on either side is a real difference to report,
  // not something to wave through because the comparison couldn't be made.
  if (!Number.isFinite(parsedA) || !Number.isFinite(parsedB)) return false;
  return parsedA === parsedB;
}
