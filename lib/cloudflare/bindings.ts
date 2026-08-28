import { getCloudflareContext } from "@opennextjs/cloudflare";
import { assertServerOnly } from "@/lib/auth/server-only";

const MODULE = "lib/cloudflare/bindings.ts";

/**
 * Four states, not two directions.
 *
 *   supabase        reads Supabase, writes Supabase
 *   dual            reads Supabase, writes Supabase + mirrors to D1   (production today)
 *   read_cloudflare reads D1,        writes Supabase + mirrors to D1   (reversible)
 *   cloudflare      reads D1,        writes D1 only                    (one-way)
 *
 * `read_cloudflare` exists so a read cutover can be undone: nothing about the
 * write path changes from `dual`, so reverting the variable and deploying
 * restores `dual`'s behaviour exactly. `cloudflare` keeps its original,
 * one-way meaning — D1 becomes the only place a write lands, and there is no
 * plain env-var revert that brings back rows written only there.
 *
 * Call sites should almost never compare against these four strings
 * directly. Ask `readsFromCloudflare()`, `writesToCloudflareOnly()` or
 * `mirrorsWritesToCloudflare()` instead — see below.
 */
export type CloudflareDataMode = "supabase" | "dual" | "read_cloudflare" | "cloudflare";

/** Exported so lib/cloudflare/cutover-domains.ts can parse per-domain overrides the same way. */
export function parseCloudflareDataMode(value: string | undefined): CloudflareDataMode {
  return value === "dual" || value === "read_cloudflare" || value === "cloudflare"
    ? value
    : "supabase";
}

/** Learner, profile and billing data authority. */
export function cloudflareDataMode(): CloudflareDataMode {
  assertServerOnly(MODULE);
  return parseCloudflareDataMode(process.env["CLOUDFLARE_DATA_MODE"]);
}

/**
 * Organization portal, permission, command and attempt-ledger authority.
 *
 * This deliberately does not inherit CLOUDFLARE_DATA_MODE. An omitted or
 * misspelled organization switch must keep using the established Supabase
 * path rather than silently cutting organization writes over to D1.
 */
export function organizationDataMode(): CloudflareDataMode {
  assertServerOnly(MODULE);
  return parseCloudflareDataMode(process.env["ORGANIZATION_DATA_MODE"]);
}

/** Whether D1 is the only authority for organization-data writes. */
export function organizationWritesToCloudflareOnly(): boolean {
  return organizationDataMode() === "cloudflare";
}

/**
 * Where a learner-data read should come from.
 *
 * True for both `cloudflare` and `read_cloudflare` — the two modes exist so
 * the *write* path can diverge behind them (mirrored vs D1-only) without the
 * read routing having to know which. Every call site in this codebase that
 * used to ask `cloudflareDataMode() === "cloudflare"` to decide where to
 * *read* from should ask this instead, so it also picks up `read_cloudflare`.
 */
export function readsFromCloudflare(): boolean {
  const mode = cloudflareDataMode();
  return mode === "cloudflare" || mode === "read_cloudflare";
}

/**
 * Whether D1 is the *only* place a learner-data write lands.
 *
 * True only for `cloudflare`. `read_cloudflare` writes Supabase (and mirrors
 * to D1) exactly like `dual` does — that write behaviour is what makes the
 * mode reversible. Every call site that used to ask
 * `cloudflareDataMode() === "cloudflare"` to decide where to *write*, or
 * whether Supabase is still authoritative for a write, should ask this.
 */
export function writesToCloudflareOnly(): boolean {
  return cloudflareDataMode() === "cloudflare";
}

/**
 * Whether a Supabase write should also be mirrored into D1.
 *
 * True for `dual` and `read_cloudflare` — both write Supabase first and then
 * copy the result to D1. False for `supabase` (no D1 write at all) and for
 * `cloudflare` (there is no separate Supabase write to mirror from). Call
 * sites that used to ask `cloudflareDataMode() === "dual"` to decide whether
 * to also attempt/queue a D1 copy should ask this instead.
 */
export function mirrorsWritesToCloudflare(): boolean {
  const mode = cloudflareDataMode();
  return mode === "dual" || mode === "read_cloudflare";
}

export interface BandUpCloudflareBindings {
  db: Env["BANDUP_DB"];
  files: Env["BANDUP_FILES"];
}

/**
 * Binding lookup is request-scoped. No binding or database handle is cached in
 * module state, which keeps local Next dev, preview Workers and production
 * Workers on the same safe path.
 */
export async function bandUpCloudflareBindings(): Promise<BandUpCloudflareBindings | null> {
  assertServerOnly(MODULE);
  try {
    const context = await getCloudflareContext({ async: true });
    const env = context.env as CloudflareEnv & Env;
    if (!env.BANDUP_DB || !env.BANDUP_FILES) return null;
    return { db: env.BANDUP_DB, files: env.BANDUP_FILES };
  } catch {
    return null;
  }
}

export async function requireBandUpCloudflareBindings(): Promise<BandUpCloudflareBindings> {
  const bindings = await bandUpCloudflareBindings();
  if (!bindings) throw new Error("Cloudflare data bindings are unavailable");
  return bindings;
}
