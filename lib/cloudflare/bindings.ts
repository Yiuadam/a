import { getCloudflareContext } from "@opennextjs/cloudflare";
import { assertServerOnly } from "@/lib/auth/server-only";

const MODULE = "lib/cloudflare/bindings.ts";

export type CloudflareDataMode = "supabase" | "dual" | "cloudflare";

function dataMode(value: string | undefined): CloudflareDataMode {
  return value === "dual" || value === "cloudflare" ? value : "supabase";
}

/** Learner, profile and billing data authority. */
export function cloudflareDataMode(): CloudflareDataMode {
  assertServerOnly(MODULE);
  return dataMode(process.env["CLOUDFLARE_DATA_MODE"]);
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
  return dataMode(process.env["ORGANIZATION_DATA_MODE"]);
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
