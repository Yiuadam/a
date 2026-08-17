/*
  A fake `@opennextjs/cloudflare` for tests that need `lib/cloudflare/bindings.ts`'s
  `bandUpCloudflareBindings()` to resolve to bindings the test controls, without
  a real Workers runtime.

  `getCloudflareContext` is the package's only export any file in this
  repository imports (see lib/cloudflare/bindings.ts). Setting
  `globalThis.__CUTOVER_FAKE_CF_ENV__` before a call and clearing it after is
  what lets one test process run several scenarios — armed, not armed, no
  bindings at all — without restarting the loader hook that redirects the
  import to this file.
*/
export async function getCloudflareContext() {
  const env = globalThis.__CUTOVER_FAKE_CF_ENV__;
  if (!env) throw new Error("no fake Cloudflare env configured for this test");
  return { env };
}
