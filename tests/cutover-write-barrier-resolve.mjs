/*
  Redirects `@opennextjs/cloudflare` to tests/fake-cloudflare-worker.mjs, on top
  of alias-resolve.mjs's `@/` rewriting. Register this one *after*
  alias-resolve.mjs so it sees imports first and can hand off anything that is
  not one of the two specifiers it cares about.

  It also redirects the bare specifier `next/server` to its own concrete
  `server.js`. Next ships no `exports` map for that subpath, so plain ESM
  resolution (unlike webpack's, or CJS `require`, both of which try a `.js`
  suffix automatically) cannot find it — every other test in this repository
  that touches lib/auth/errors.ts or anything importing it does so by reading
  the file as text rather than importing it, which is exactly what this file
  does not want to be limited to.
*/
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const FAKE_CLOUDFLARE_WORKER = pathToFileURL(
  join(process.cwd(), "tests", "fake-cloudflare-worker.mjs"),
).href;
const NEXT_SERVER = pathToFileURL(join(process.cwd(), "node_modules", "next", "server.js")).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@opennextjs/cloudflare") {
    return { url: FAKE_CLOUDFLARE_WORKER, shortCircuit: true, format: "module" };
  }
  if (specifier === "next/server") {
    return { url: NEXT_SERVER, shortCircuit: true, format: "commonjs" };
  }
  return nextResolve(specifier, context);
}
