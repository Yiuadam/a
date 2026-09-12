/*
  Lets a test import lib/entitlements/useSessions.ts directly, the way
  tests/alias-resolve.mjs lets tests import anything using the `@/` alias.

  useSessions.ts exports a pure function this repository's tests need to
  exercise behaviourally (realSessionTier — see tests/session-tier-outage.
  test.mjs), but the same file also exports the React hook useSessionAccess(),
  which reads lib/hooks.ts's useProfile(), which reads next/navigation's
  usePathname() for a reason that has nothing to do with either. Next's own
  bundler resolves that import at build time; a plain Node process run by
  `node --test` has no bundler and no `next/navigation` package to resolve it
  against, so the import fails before the module the test actually wants
  finishes loading — usePathname is never called by realSessionTier, only
  imported alongside it.

  So this hook answers that one specifier with an inert stub instead of
  letting resolution fail. It is deliberately narrow: only the bare specifier
  "next/navigation" is touched, and everything else falls through to Node's
  ordinary resolution (chained with tests/alias-resolve.mjs, registered
  separately) exactly as if this hook were not there.
*/
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/navigation") {
    return {
      url: 'data:text/javascript,export function usePathname(){return "/";}',
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
