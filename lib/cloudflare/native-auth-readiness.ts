import { assertServerOnly } from "@/lib/auth/server-only";
import { nativeAuthEnabled } from "@/lib/auth/env";
import {
  cloudflareDataMode,
  organizationDataMode,
  organizationWritesToCloudflareOnly,
  writesToCloudflareOnly,
} from "./bindings";

/*
  Native identity has to move with the data it authenticates.

  A Cloudflare-issued token can identify an existing BandUp id, but it cannot
  make the Supabase-only profile, organisation, billing or usage paths accept
  that token.  Serving native sign-in before both application authorities are
  Cloudflare would therefore look like a successful login followed by missing
  data.  Keep the switch fail-closed, while retaining Supabase as the working
  compatibility path until the full prerequisite is true.
*/

const MODULE = "lib/cloudflare/native-auth-readiness.ts";

export interface NativeAuthDataAuthority {
  learner: ReturnType<typeof cloudflareDataMode>;
  organization: ReturnType<typeof organizationDataMode>;
  ready: boolean;
}

/** The data authorities required before a native credential can be served. */
export function nativeAuthDataAuthority(): NativeAuthDataAuthority {
  assertServerOnly(MODULE);
  const learner = cloudflareDataMode();
  const organization = organizationDataMode();
  return {
    learner,
    organization,
    ready: writesToCloudflareOnly() && organizationWritesToCloudflareOnly(),
  };
}

/**
 * The effective feature switch. `CLOUDFLARE_NATIVE_AUTH=1` alone never
 * disables a working Supabase login: it becomes active only after both D1
 * authorities above are in their final, one-way mode.
 */
export function nativeAuthCutoverActive(): boolean {
  assertServerOnly(MODULE);
  return nativeAuthEnabled() && nativeAuthDataAuthority().ready;
}
