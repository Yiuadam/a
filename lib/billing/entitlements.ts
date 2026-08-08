import { assertServerOnly } from "@/lib/auth/server-only";
import { rpc } from "@/lib/auth/supabase";
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
  source: "anonymous" | "default" | "role" | "stripe" | "apple";
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
  const tier: Tier =
    raw.tier === "admin" ? "admin" : raw.tier === "pro" ? "pro" : "free";
  const source =
    raw.source === "role" ||
    raw.source === "stripe" ||
    raw.source === "apple" ||
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

/**
 * Resolves the entitlement for a user id, server-side, from the database.
 *
 * Throws if the database cannot be reached. The caller decides what an
 * unreachable database means — see `usageFailOpen` — because "assume free" and
 * "refuse the request" are different answers in different places.
 */
export async function resolveEntitlement(userId: string | null): Promise<Entitlement> {
  assertServerOnly(MODULE);
  if (!userId) return ANONYMOUS_ENTITLEMENT;
  const raw = await rpc<RawEntitlement | null>("resolve_entitlement", { p_user_id: userId });
  return normalise(raw);
}
