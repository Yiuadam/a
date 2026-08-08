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
    // Emscripten output, vendored by scripts/vendor-shout.mjs rather than
    // written here. Linting generated wasm glue says nothing useful.
    "public/whisper/**",
  ]),
]);

export default eslintConfig;
