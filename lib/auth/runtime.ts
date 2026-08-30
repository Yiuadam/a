import { accountsEnabled, supabaseConfig } from "./env";
import { nativeAuthCutoverActive } from "@/lib/cloudflare/native-auth-readiness";
import { assertServerOnly } from "./server-only";

const MODULE = "lib/auth/runtime.ts";

/**
 * Whether a request can be authenticated by an account authority available to
 * this deployment.  During the staged cutover either a legacy Supabase
 * session or a Cloudflare-native session can be valid; after the cutover this
 * must stay true without any Supabase secret at all.
 */
export function accountRuntimeEnabled(): boolean {
  assertServerOnly(MODULE);
  return accountsEnabled() && (nativeAuthCutoverActive() || supabaseConfig() !== null);
}
