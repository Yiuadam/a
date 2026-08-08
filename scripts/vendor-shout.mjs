#!/usr/bin/env node
/*
  Copies the whisper.cpp WASM build out of node_modules and into public/.

  The file is an Emscripten single-file module: the wasm binary and the pthread
  worker are both inlined into it, and it resolves its own paths from
  `import.meta.url`. Bundlers routinely break that, so upstream's advice is to
  serve it as a plain static asset and load it with a runtime `import()` — which
  is what lib/transcribe.ts does. Keeping the copy in git means every build
  path (Vercel, the Cloudflare worker, the static iOS export) has it without a
  build step of its own.

  Run this after bumping @transcribe/shout, and commit the result.
*/
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pkg = require("@transcribe/shout/package.json");
const src = join(dirname(require.resolve("@transcribe/shout")), "src", "shout", "shout.wasm.js");
const destDir = join(process.cwd(), "public", "whisper");
const dest = join(destDir, "shout.wasm.js");

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);

const kb = Math.round(statSync(dest).size / 1024);
console.log(`Vendored @transcribe/shout@${pkg.version} -> public/whisper/shout.wasm.js (${kb} kB)`);
