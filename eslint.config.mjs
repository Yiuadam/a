import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Build outputs for the other two targets.
    "out-mobile/**",
    ".open-next/**",
    // Wrangler's scratch directory. `npm run cf:preview` leaves bundled worker
    // code here, and linting it turns a clean tree red with hundreds of
    // warnings about generated code — which is exactly what happened after
    // running the Worker locally to test the account routes.
    ".wrangler/**",
    "ios/**",
    // Agent worktrees. A worktree is a whole second checkout of this repo,
    // build output and all, so without this `npx eslint .` lints the project
    // twice — and races the agent still writing into it, which surfaces as
    // ENOENT on a file that existed when the glob ran and was gone when the
    // read did. Nothing in here is source that ships.
    ".claude/**",
    // Emscripten output, vendored by scripts/vendor-shout.mjs rather than
    // written here. Linting generated wasm glue says nothing useful.
    "public/whisper/**",
  ]),
]);

export default eslintConfig;
