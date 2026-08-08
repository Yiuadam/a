#!/usr/bin/env node
/*
  Builds the static bundle that ships inside the iOS app.

  A static export cannot contain server route handlers, but the same repo also
  deploys to Cloudflare Workers where those routes must exist. So the API
  directory is moved aside for the duration of the export and restored
  afterwards — including if the build fails.
*/
import { execSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const apiDir = join(root, "app", "api");
const stash = join(root, ".api-stash");

if (!process.env.NEXT_PUBLIC_API_BASE) {
  console.error(
    "\nNEXT_PUBLIC_API_BASE is not set.\n" +
      "The iOS bundle has no server of its own, so it must call your deployed\n" +
      "API. Set it to your deployment's URL, for example:\n\n" +
      "  NEXT_PUBLIC_API_BASE=https://bandup.siksafe-realtime-ai-vision.workers.dev npm run build:mobile\n",
  );
  process.exit(1);
}

if (existsSync(stash)) rmSync(stash, { recursive: true, force: true });

let moved = false;
try {
  if (existsSync(apiDir)) {
    renameSync(apiDir, stash);
    moved = true;
  }
  // Next generates a type validator that imports every route it has seen. Left
  // over from an earlier build, it still references the routes we just moved
  // aside and fails the type check. Clear it so it is regenerated for this
  // build; the normal build regenerates its own copy too.
  for (const dir of [join(root, ".next", "dev", "types"), join(root, ".next", "types")]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  execSync("next build", {
    stdio: "inherit",
    env: { ...process.env, MOBILE_BUILD: "1" },
  });
} finally {
  if (moved) renameSync(stash, apiDir);
}

console.log("\nStatic bundle written to out-mobile/. Next: npx cap sync ios\n");
