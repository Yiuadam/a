#!/usr/bin/env node
/*
  Prepare the WeChat mini program shell.

  There is nothing to compile. The mini program is a one-page shell around a
  `<web-view>` (see miniprogram/app.js for why it is a shell rather than a
  port), so "building" it means two things: point it at the deployment it
  should open, and check it is actually openable before WeChat's own tooling
  is the thing that tells you it is not.

  The checks are here because the failure they catch is silent and late. A
  missing page file or a marker that has drifted from lib/platform.ts does not
  stop DevTools from opening the project; it shows as a blank screen, or as a
  site that quietly renders its full glass inside a web-view that cannot
  afford it, and by then the loop is a manual one.

  Usage:
    npm run build:miniprogram
    MINIPROGRAM_ORIGIN=https://pr-178-bandup.ad1m.workers.dev npm run build:miniprogram
*/
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const shell = join(root, "miniprogram");

const problems = [];

/* Every file WeChat needs. A mini program page is four files with the same
   basename, and a missing one is not an error at pack time — it is a page
   that renders nothing. */
const required = [
  "app.js",
  "app.json",
  "app.wxss",
  "sitemap.json",
  "project.config.json",
  "config.js",
  "pages/index/index.js",
  "pages/index/index.json",
  "pages/index/index.wxml",
  "pages/index/index.wxss",
];

for (const file of required) {
  try {
    readFileSync(join(shell, file), "utf8");
  } catch {
    problems.push(`missing ${file}`);
  }
}

/*
  The marker has to agree with the site, or the shell announces itself in a
  language the page does not read and the glass stays on. Read rather than
  imported: lib/platform.ts is TypeScript, and this script has no build step.
*/
const platform = readFileSync(join(root, "lib", "platform.ts"), "utf8");
const declared = platform.match(/export const MINIPROGRAM_SHELL = "([^"]+)"/);
if (!declared) {
  problems.push("lib/platform.ts no longer declares MINIPROGRAM_SHELL");
}

const origin = process.env.MINIPROGRAM_ORIGIN ?? "https://bandup.life";
if (!/^https:\/\/[^/]+$/.test(origin)) {
  /* https because WeChat requires it of a business domain, and no trailing
     slash because the page concatenates a path straight onto this. */
  problems.push(`MINIPROGRAM_ORIGIN must be an https origin with no path or trailing slash — got ${origin}`);
}

if (problems.length > 0) {
  console.error("Mini program shell is not ready:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const marker = declared[1];
const configPath = join(shell, "config.js");
const config = readFileSync(configPath, "utf8");
const stamped = config
  .replace(/SITE_ORIGIN: "[^"]*"/, `SITE_ORIGIN: "${origin}"`)
  .replace(/SHELL_MARKER: "[^"]*"/, `SHELL_MARKER: "${marker}"`);

if (stamped !== config) writeFileSync(configPath, stamped);

const appid = JSON.parse(readFileSync(join(shell, "project.config.json"), "utf8")).appid;

console.log(`Mini program shell OK: opens ${origin}/?shell=${marker}`);
console.log(
  appid
    ? `AppID ${appid}.`
    : "AppID is still blank — set it in miniprogram/project.config.json, or pick it when DevTools asks.",
);
console.log("Next: open the miniprogram/ folder in WeChat DevTools. See miniprogram/README.md.");
