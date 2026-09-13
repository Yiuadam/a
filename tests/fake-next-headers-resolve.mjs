/*
  Redirects the bare specifier `next/headers` to a tiny in-memory fake, the
  same way tests/cutover-write-barrier-resolve.mjs redirects `next/server`
  and `@opennextjs/cloudflare`.

  lib/billing/region.ts is the only module in this codebase that imports
  `next/headers` (`await headers()`, read for `cf-ipcountry`). The real
  package's `headers()` reads Next's request-scoped AsyncLocalStorage, which
  does not exist outside an actual Next request — there is no fixture for it
  the way there is for a Cloudflare binding, so a test controls the fake
  directly through `globalThis.__FAKE_NEXT_HEADERS__` instead: a zero-arg
  function returning an object with a `get(name)` method, exactly the corner
  of the real Headers API that region.ts touches.
*/
const VIRTUAL_URL = "fake-next-headers:virtual";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/headers") {
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
        export async function headers() {
          const impl = globalThis.__FAKE_NEXT_HEADERS__;
          if (!impl) {
            throw new Error("fake-next-headers: no fake headers configured for this test");
          }
          return impl();
        }
      `,
    };
  }
  return nextLoad(url, context);
}
