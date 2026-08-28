import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

/*
  Lets Node import the app's TypeScript modules directly.

  Node can strip types on its own, but it will not guess extensions, so the
  `./band` style imports the app uses fail to resolve. This hook retries an
  extensionless relative specifier as `.ts`, which is enough to run lib/ code in
  a plain script without a build step.
*/
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const projectRoot = fileURLToPath(new URL("../", import.meta.url));
    const target = pathToFileURL(join(projectRoot, `${specifier.slice(2)}.ts`)).href;
    try {
      return await nextResolve(target, context);
    } catch {
      // A client component may be .tsx; the normal resolver can report a
      // useful error for that unsupported test shape rather than hiding it.
    }
  }
  if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      // Fall through to the normal resolution and let it report the failure.
    }
  }
  return nextResolve(specifier, context);
}
