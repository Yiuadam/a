/*
  Copies the prerendered pages OpenNext wrote to .open-next/cache into the
  static assets directory, where the static-assets incremental cache reads
  them (open-next.config.ts).

  `opennextjs-cloudflare populateCache local` does the same copy, but first
  opens a wrangler platform proxy to read the Worker's environment, and in CI
  that needs a Cloudflare API token a build step has no business holding. The
  copy itself needs nothing — it is fs.cpSync, the same call the CLI makes —
  so the build runs it directly. The destination path is the one the cache
  override resolves keys against; if that ever changes upstream the test in
  tests/open-next-config.test.mjs is what notices.
*/
import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const OUTPUT_DIR = ".open-next";
const SOURCE = join(OUTPUT_DIR, "cache");
const DESTINATION = join(OUTPUT_DIR, "assets", "cdn-cgi", "_next_cache");

if (!existsSync(SOURCE)) {
  console.error(`No ${SOURCE} — run \`opennextjs-cloudflare build\` first.`);
  process.exit(1);
}

cpSync(SOURCE, DESTINATION, { recursive: true });

function countFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    n += statSync(full).isDirectory() ? countFiles(full) : 1;
  }
  return n;
}

console.log(`Static assets cache: ${countFiles(DESTINATION)} entries under ${DESTINATION}`);
