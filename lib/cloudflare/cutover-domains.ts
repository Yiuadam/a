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
 * `billing_entitlement_runtime` was the first domain to call it, from
 * lib/billing/entitlements.ts, once its D1 reader existed to call it for.
 * `admin_user_directory` and `admin_statistics` call it from
 * app/api/admin/users/route.ts, app/api/admin/users/[id]/route.ts and
 * app/api/admin/stats/route.ts — each only around the figures that are not
 * auth.users identity reads; see those domains' descriptions below for what
 * stays on Supabase regardless of the mode this returns.
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
    description:
      "Per-account plan/access-source shown by the directory (both the list and the " +
      "detail page) has a D1 read path (lib/cloudflare/admin-entitlement-directory.ts) " +
      "used when this domain reads from Cloudflare; an account absent from the D1 " +
      "mirror is marked d1_mirror_missing rather than shown as an ordinary free-tier " +
      "account. The roster itself — which accounts exist, and their email, username, " +
      "display name and registration date (admin_users_page / admin_user_detail) — is " +
      "auth.users identity data and stays on Supabase regardless of this domain's mode, " +
      "by the owner's decision that Supabase Auth is not migrating.",
    supported: true,
  },
  {
    domain: "admin_statistics",
    description:
      "admin_usage_daily and admin_usage_breakdown (lib/cloudflare/admin-stats.ts, pure " +
      "usage_events reads) and admin_tier_counts (same file, via the entitlement " +
      "resolver) have a D1 read path used when this domain reads from Cloudflare. " +
      "admin_user_count and admin_signups_daily are auth.users identity reads and stay " +
      "on Supabase regardless of this domain's mode, by the same decision as " +
      "admin_user_directory above.",
    supported: true,
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
    description: "AI usage rate limiting and quota accounting run against Supabase RPCs.",
    supported: false,
  },
  {
    domain: "ai_cost_write_authority",
    description: "Anthropic cost-ledger writes are recorded through Supabase RPCs.",
    supported: false,
  },
  {
    domain: "avatar_object_parity",
    description: "Avatar object bytes in R2 are not proven byte-identical to Supabase Storage.",
    supported: false,
  },
  {
    domain: "progress_payload_integrity",
    description: "Progress-snapshot JSON payloads are not proven identical, only their rows.",
    supported: false,
  },
  {
    domain: "billing_payload_object_parity",
    description: "Stored Stripe event payload objects are not proven identical.",
    supported: false,
  },
  {
    domain: "provider_event_payload_object_parity",
    description: "Stored provider-event payload objects are not proven identical.",
    supported: false,
  },
  {
    domain: "cutover_write_barrier",
    description: "Nothing yet refuses a write once a domain is meant to be Cloudflare-only.",
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
