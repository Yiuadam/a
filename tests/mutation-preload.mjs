/*
  Loaded with `node --import` only while Stryker runs the tests.

  Stryker copies the project into a sandbox and rewrites every mutated source
  file with its mutant switches, so a test that reads lib/billing/stripe.ts as
  text and looks for a sentence in it finds `stryMutAct_9fa48("885") ? "" :
  ...` instead. Many tests here are exactly that kind of check. They can never
  kill a mutant — a regex over source text does not run the code — so
  redirecting their reads to the pristine file outside the sandbox loses
  nothing and stops the whole dry run failing on the first instrumented file.

  Imports are untouched: the ESM loader reads files through its own internals,
  not through fs.readFileSync, so behaviour tests still exercise the mutant.
*/
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";

const original = process.env.STRYKER_ORIGINAL_ROOT;
if (original) {
  const sandbox = process.cwd();
  const sourceLike = /\.(ts|tsx|mjs|js|jsx)$/;
  const redirect = (path) => {
    const p = typeof path === "string" ? path : path instanceof URL ? path.pathname : null;
    if (!p || !sourceLike.test(p)) return path;
    const abs = isAbsolute(p) ? p : resolve(sandbox, p);
    const rel = relative(sandbox, abs);
    if (rel.startsWith("..") || rel.startsWith("node_modules")) return path;
    const pristine = join(original, rel);
    return fs.existsSync(pristine) ? pristine : path;
  };
  const readFileSync = fs.readFileSync;
  fs.readFileSync = function patched(path, options) {
    return readFileSync.call(this, redirect(path), options);
  };
  const readFile = fs.promises.readFile;
  fs.promises.readFile = function patched(path, options) {
    return readFile.call(this, redirect(path), options);
  };
  syncBuiltinESMExports();
}
