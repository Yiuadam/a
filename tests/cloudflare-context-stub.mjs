/*
  A controllable stand-in for `@opennextjs/cloudflare`'s `getCloudflareContext`.

  `lib/cloudflare/bindings.ts` calls it directly, with no seam a test can pass
  a fake binding through — unlike the functions further down the D1 call chain
  (`replicateAuthoritativeStripeState` and friends), which all accept an
  optional `providedBindings` precisely so a test can skip this. Testing
  `lib/billing/entitlements.ts`'s *wiring* — that the Cloudflare branch is only
  taken when the domain's mode says so, and that the parity tool asks both
  backends regardless — has no such seam to use, because `resolveEntitlement`
  and `resolveEntitlementForParity` are the public, no-bindings-parameter
  surface every real caller uses. So this intercepts the import itself:
  `globalThis.__FAKE_CLOUDFLARE_CONTEXT__` is a per-test value a test sets
  before calling into that surface and clears in a `finally`.
*/
const VIRTUAL_URL = "cloudflare-context-stub:virtual";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@opennextjs/cloudflare") {
    return { url: VIRTUAL_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === VIRTUAL_URL) {
    return {
      format: "module",
      shortCircuit: true,
      source: `
        export async function getCloudflareContext() {
          if (!globalThis.__FAKE_CLOUDFLARE_CONTEXT__) {
            throw new Error("cloudflare-context-stub: no fake context set for this test");
          }
          return globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
        }
      `,
    };
  }
  return nextLoad(url, context);
}
