/*
  Lets these tests import the app's modules the way the app writes its imports.

  scripts/ts-resolve.mjs already retries an extensionless *relative* specifier
  as `.ts`, which is enough for a module that only imports its neighbours. The
  billing modules do not: they use the `@/lib/...` alias that tsconfig.json
  maps to the repository root, and Node knows nothing about tsconfig paths.

  So this hook does both jobs — rewrite `@/x` to an absolute path, then let the
  extension retry run — and it is deliberately a separate file rather than an
  edit to the existing one, because the existing one is shared with scripts
  that have no need of the alias.
*/
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();

export async function resolve(specifier, context, nextResolve) {
  let request = specifier;

  if (request.startsWith("@/")) {
    request = pathToFileURL(join(ROOT, request.slice(2))).href;
  }

  const looksExtensionless =
    !/\.[cm]?[jt]sx?$/.test(request) && (request.startsWith(".") || request.startsWith("file:"));

  if (looksExtensionless) {
    try {
      return await nextResolve(`${request}.ts`, context);
    } catch {
      // Fall through and let normal resolution report the real failure.
    }
  }

  return nextResolve(request, context);
}
