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
    /*
      Worktrees created for background agents. Each is a full checkout with its
      own .next and node_modules, so without this `npx eslint .` lints every
      agent's build output as well as this one's — thousands of warnings about
      generated code, and a red tree that has nothing to do with the change in
      front of you.
    */
    ".claude/**",
    "ios/**",
    // Emscripten output, vendored by scripts/vendor-shout.mjs rather than
    // written here. Linting generated wasm glue says nothing useful.
    "public/whisper/**",
  ]),
]);

export default eslintConfig;
