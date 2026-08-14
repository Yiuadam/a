#!/usr/bin/env node
/*
  Builds the static bundle that ships inside the iOS app.

  A static export cannot contain server route handlers, but the same repo also
  deploys to Cloudflare Workers where those routes must exist. So the API
  directory is moved aside for the duration of the export and restored
  afterwards — including if the build fails.

  The website owner's console is also excluded. It depends on live, dynamic
  user and sitting routes that a static iOS bundle cannot generate, and it is
  intentionally available only on the canonical website.

  The billing pages go with it, for a different reason. Apple requires digital
  content used inside an iOS app to be sold through In-App Purchase and takes
  30% of it; BandUp's answer is that the iOS app sells nothing, so there is
  nothing to take a cut of. Moving /pricing and /billing out of the export
  rather than hiding them behind a flag means there is nothing left to find —
  no route, no price, no button. NEXT_PUBLIC_MOBILE_BUILD is what stops the
  rest of the interface pointing at them; see lib/platform.ts.

  The multi-path stash is adapted from claude/stripe-ielts-integration-rd7dzv.
*/
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const stash = join(root, ".mobile-stash");

/** Everything that must not exist in the iOS bundle, relative to the repo. */
const EXCLUDED = [
  join("app", "api"),
  join("app", "admin"),
  join("app", "pricing"),
  join("app", "billing"),
];

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
mkdirSync(stash, { recursive: true });

/** Where each excluded path is parked, keyed by where it belongs. */
const moved = new Map();

try {
  for (const relative of EXCLUDED) {
    const from = join(root, relative);
    if (!existsSync(from)) continue;
    // Flattened into one stash entry per path, so two nested directories
    // cannot land on top of each other.
    const to = join(stash, relative.replace(/[\\/]/g, "__"));
    renameSync(from, to);
    moved.set(from, to);
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
    env: { ...process.env, MOBILE_BUILD: "1", NEXT_PUBLIC_MOBILE_BUILD: "1" },
  });
} finally {
  for (const [from, to] of moved) renameSync(to, from);
  rmSync(stash, { recursive: true, force: true });
}

console.log("\nStatic bundle written to out-mobile/. Next: npx cap sync ios\n");
