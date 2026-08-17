import { assertServerOnly } from "@/lib/auth/server-only";
import {
  cloudflareDataMode,
  parseCloudflareDataMode,
  type CloudflareDataMode,
} from "./bindings";

const MODULE = "lib/cloudflare/cutover-domains.ts";

/**
 * The application-data domains that stay unsupported for a Cloudflare-only
 * cutover no matter what CLOUDFLARE_DATA_MODE says, because the runtime code
 * that would make them safe does not exist yet.
 *
 * This used to be ten string literals pushed straight into
 * migration-readiness.ts's `unsupportedDomains`. That made "is this domain
 * ready" a fact nobody could see except by reading the array — a later stage
 * finishing one domain had to remember to delete its own name from a list
 * shared with nine others it had no reason to touch. Here it is instead one
 * entry each stage owns: build the reader, flip `supported` to `true`, done.
 *
 * Nothing in this file makes a domain's actual reads or writes go to
 * Cloudflare. Do not add a branch here that changes runtime routing — that is
 * what `domainDataMode()` (and `domainReadsFromCloudflare()`) below is for.
 * `billing_entitlement_runtime` is the first domain to call it, from
 * lib/billing/entitlements.ts, once its D1 reader existed to call it for.
 */
export type CutoverDomain =
  | "admin_user_directory"
  | "admin_statistics"
  | "billing_entitlement_runtime"
  | "usage_quota_authority"
  | "ai_cost_write_authority"
  | "avatar_object_parity"
  | "progress_payload_integrity"
  | "billing_payload_object_parity"
  | "provider_event_payload_object_parity"
  | "cutover_write_barrier";

export interface CutoverDomainDefinition {
  domain: CutoverDomain;
  /** What still runs against Supabase regardless of CLOUDFLARE_DATA_MODE. */
  description: string;
  /**
   * Flip this to `true` once the domain has a proven Cloudflare-only runtime
   * path. Nothing reads this field yet except the readiness report — turning
   * it on does not, by itself, move any reads or writes anywhere.
   */
  supported: boolean;
}

export const CUTOVER_DOMAINS: readonly CutoverDomainDefinition[] = [
  {
    domain: "admin_user_directory",
    description: "The admin user list and search still query Supabase directly.",
    supported: false,
  },
  {
    domain: "admin_statistics",
    description: "Owner-facing usage/growth statistics are computed from Supabase.",
    supported: false,
  },
  {
    domain: "billing_entitlement_runtime",
    description:
      "Entitlement checks (lib/billing/entitlements.ts) have a D1 read path " +
      "(lib/cloudflare/entitlement-runtime.ts) and an admin parity tool " +
      "(/api/admin/cloudflare/entitlement-parity) that resolves every account through " +
      "both backends. Flipping this domain's mode still needs, in order: the " +
      "subscriptions.provider and cloudflare_replica_outbox.operation widenings from " +
      "the pull request that added this, the promo backfill it also describes, and a " +
      "zero-mismatch run of the parity tool.",
    supported: true,
  },
  {
    domain: "usage_quota_authority",
    description:
      "checkAiUsage (lib/usage/guard.ts) has a D1-only admission path " +
      "(lib/cloudflare/usage-quota-authority.ts) that enforces the monthly, weekly and " +
      "per-IP caps as a single guarded statement per attempt, with no advisory lock and no " +
      "read-then-write gap. It mints its own numeric usage_events ids from a D1 counter that " +
      "must be seeded above Supabase's current maximum before this domain's mode is set to " +
      "'cloudflare' for the first time — see the pull request that added this file for the " +
      "exact wrangler d1 execute commands and for why the counter is not seeded automatically.",
    supported: true,
  },
  {
    domain: "ai_cost_write_authority",
    description:
      "recordAnthropicMessageCost (lib/ai/cost-tracking.ts) has a D1-only write path " +
      "(lib/cloudflare/ai-cost-write-authority.ts) that dedupes on provider_request_id exactly " +
      "as record_ai_cost_event does, and mints its own numeric ai_cost_events ids from a " +
      "separate D1 counter with the same seeding requirement as usage_quota_authority's. The " +
      "owner-only coverage/backfill writes (setAiCostCoverage, record_ai_cost_backfill) are " +
      "unaffected by this domain and still go through Supabase regardless of its mode — they " +
      "are out of scope for the pull request that added this entry.",
    supported: true,
  },
  {
    domain: "avatar_object_parity",
    description: "Avatar object bytes in R2 are not proven byte-identical to Supabase Storage.",
    supported: false,
  },
  {
    domain: "progress_payload_integrity",
    description: "Progress-snapshot JSON payloads are canonicalised and hashed on both sides "
      + "(lib/cloudflare/payload-parity.ts), admin-only via ?payloadParity= on the readiness route.",
    supported: true,
  },
  {
    domain: "billing_payload_object_parity",
    description: "Stored Stripe event payload objects are canonicalised and hashed on both sides "
      + "(lib/cloudflare/payload-parity.ts), admin-only via ?payloadParity= on the readiness route.",
    supported: true,
  },
  {
    domain: "provider_event_payload_object_parity",
    description: "Stored provider-event payload objects are canonicalised and hashed on both sides "
      + "(lib/cloudflare/payload-parity.ts), admin-only via ?payloadParity= on the readiness route.",
    supported: true,
  },
  {
    domain: "cutover_write_barrier",
    /*
      The mechanism exists now — lib/cloudflare/write-barrier.ts, armed only
      through app/api/admin/cloudflare/write-barrier/route.ts — but `supported`
      stays `false` here on purpose. For the other nine entries "supported"
      is a fact a code review settles once and for all: a reader either exists
      or it does not. This one is not that kind of fact — whether a barrier is
      actually armed is live D1 state that can be true this minute and false
      the next, and a boolean baked into this array at module load time cannot
      say which. Flipping it to `true` would claim a cutover is safe to finish
      regardless of whether the owner ever armed anything. The readiness
      report's `writeBarrier` field carries the live answer instead — armed,
      not armed, or armed at a given time — see
      lib/cloudflare/migration-readiness.ts.
    */
    description: "The refusal mechanism exists; whether it is armed is reported separately as live D1 state, not as a fact this registry can hold.",
    supported: false,
  },
];

/** Domains a Cloudflare-only cutover cannot yet claim, derived from the registry above. */
export function unsupportedCutoverDomains(): CutoverDomain[] {
  return CUTOVER_DOMAINS.filter((entry) => !entry.supported).map((entry) => entry.domain);
}

function overrideEnvVar(domain: CutoverDomain): string {
  return `CLOUDFLARE_DATA_MODE_${domain.toUpperCase()}`;
}

/**
 * A domain's effective mode: its own override if one is set, else the
 * learner switch — same shape as `organizationDataMode()`'s relationship to
 * `cloudflareDataMode()`. This lets the owner flip a cheap domain (admin
 * statistics, where a wrong number costs a chart) ahead of an expensive one
 * (usage quotas, where wrong means locking someone out or giving away AI
 * spend) without moving every domain at once.
 *
 * A garbled override (like a garbled CLOUDFLARE_DATA_MODE) parses to
 * `"supabase"` rather than silently inheriting the learner switch — an
 * override that is present but broken must not accidentally become *more*
 * aggressive than having no override at all.
 */
export function domainDataMode(domain: CutoverDomain): CloudflareDataMode {
  assertServerOnly(MODULE);
  const override = process.env[overrideEnvVar(domain)];
  return override !== undefined ? parseCloudflareDataMode(override) : cloudflareDataMode();
}

/**
 * Where a read for this specific domain should come from — `domainDataMode`
 * plus the same `cloudflare`/`read_cloudflare` rule `readsFromCloudflare()`
 * applies to the learner switch as a whole. See that function's comment in
 * ./bindings for why both modes count: the domain's *write* path is free to
 * differ behind them without a read call site having to know which.
 */
export function domainReadsFromCloudflare(domain: CutoverDomain): boolean {
  const mode = domainDataMode(domain);
  return mode === "cloudflare" || mode === "read_cloudflare";
}

/**
 * Whether D1 is the *only* place a write for this specific domain lands —
 * `domainDataMode` plus the same `writesToCloudflareOnly()` rule the learner
 * switch uses as a whole (true only for literal `'cloudflare'`).
 *
 * `usage_quota_authority` and `ai_cost_write_authority` are the first two
 * domains that ask this rather than `domainReadsFromCloudflare`: both guard a
 * write (an admission decision, a cost-ledger row), not a read, and both are
 * one-way once flipped — see the D1 id-counter seeding requirement on each
 * domain's entry above for why there is no plain env-var revert back to
 * Supabase authority the way `read_cloudflare` gives the learner switch.
 */
export function domainWritesToCloudflareOnly(domain: CutoverDomain): boolean {
  return domainDataMode(domain) === "cloudflare";
}
