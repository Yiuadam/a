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
    // Agent worktrees. A worktree is a whole second checkout of this repo,
    // build output and all, so without this `npx eslint .` lints the project
    // twice — and races the agent still writing into it, which surfaces as
    // ENOENT on a file that existed when the glob ran and was gone when the
    // read did. Nothing in here is source that ships.
    ".claude/**",
    // Emscripten output, vendored by scripts/vendor-shout.mjs rather than
    // written here. Linting generated wasm glue says nothing useful.
    "public/whisper/**",
    // Minified Kokoro/Transformers browser runtime. This is pinned, reviewed
    // third-party output; lint the BandUp adapter, not two megabytes of its
    // generated distribution bundle.
    "public/vendor/kokoro/**",
  ]),
  {
    /*
      The WeChat mini program shell.

      Linted rather than ignored — it is hand-written source that ships, and
      the generated iOS project above is not. But it does not run in this
      project's runtime: WeChat's is CommonJS, and App, Page and wx are
      globals it provides. The TypeScript preset reads `require` as a mistake
      because in a Next.js file it would be one, and reads the globals as
      undefined because in a browser they are.
    */
    files: ["miniprogram/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        App: "readonly",
        Page: "readonly",
        wx: "readonly",
        console: "readonly",
        module: "writable",
        require: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

export default eslintConfig;
