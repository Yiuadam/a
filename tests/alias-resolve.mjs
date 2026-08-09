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
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

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

/*
  JSON, without the import attribute.

  A bundler treats `import data from "./x.json"` as ordinary; Node's ESM loader
  refuses it unless the import statement says `with { type: "json" }`. The app
  is built by a bundler and cannot carry that attribute, so a module that reads
  the content bank could not be imported by a test at all — which is the class
  of module most worth testing.

  Handing it back as a module whose default export is the parsed literal avoids
  the attribute check rather than trying to satisfy it, and gives the importer
  exactly what the bundler would have.
*/
export async function load(url, context, nextLoad) {
  if (url.endsWith(".json")) {
    const text = await readFile(fileURLToPath(url), "utf8");
    return {
      format: "module",
      shortCircuit: true,
      source: `export default ${text};`,
    };
  }
  return nextLoad(url, context);
}
