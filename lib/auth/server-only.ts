/*
  A hard stop for modules that must never execute in a browser.

  Next.js already refuses to inline a non-NEXT_PUBLIC_ environment variable
  into a client bundle, so a secret cannot reach the browser through
  `process.env` even by mistake. That is a build-time guarantee and it is the
  main one. This module is the second, runtime layer: if a refactor ever pulls
  one of these files into a client component, the failure is a loud throw
  during development rather than a quiet leak in production.

  It is deliberately not the `server-only` package. That package works by
  failing the build, which is stronger — but it is a dependency, and this lane
  is meant to add as little as possible to the tree. The bundle check in
  tests/no-secret-leak.test.mjs closes the same gap at CI time.
*/

export function assertServerOnly(moduleName: string): void {
  if (typeof window !== "undefined") {
    throw new Error(
      `${moduleName} is server-only and must not be imported from a client component.`,
    );
  }
}
