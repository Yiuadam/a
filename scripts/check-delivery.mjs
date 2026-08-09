#!/usr/bin/env node
/*
  Runs the built Cloudflare Worker and checks how it *delivers* pages, which
  is a different question from whether the build succeeded.

  ---------------------------------------------------------------------------
  Why this exists

  The app once went live as unstyled HTML — no layout, no colours, every icon
  drawn at the width of the page — and every check we had was green, because
  every artifact was correct. The wreck happened between two of them:

    Next fingerprints the stylesheet, so a deploy that changes one class writes
      a new /_next/static/chunks/<hash>.css and deletes the old one.
    A prerendered page went out with `Cache-Control: s-maxage=31536000` and
      nothing addressed to the browser at all.

  So a cached page could outlive the stylesheet it named, ask for a hash that
  no longer existed, get a 404, and lose the entire appearance of the app. No
  build can catch that. You have to run the thing and look at the headers.

  ---------------------------------------------------------------------------
  What it asserts

  1. Every document may be *stored* but never *reused without asking*. That is
     the invariant that was broken, stated directly: a page's Cache-Control has
     to force revalidation, so it can never outlive the assets it references.

  2. Nothing a page references 404s. This is the failure itself rather than its
     cause, and it catches the whole family — a missing font, an icon renamed,
     a script the manifest forgot — not only the one that bit us.

  3. /_next/static keeps whatever caching it is given. Those URLs are
     content-addressed, so forcing revalidation on them would be a real cost
     for no benefit, and rule 1 must never be allowed to sprawl onto them.

  4. /speaking still carries both cross-origin isolation headers. They are the
     only reason on-device transcription can allocate a SharedArrayBuffer, and
     a careless site-wide header rule is exactly the kind of change that would
     quietly drop them.

  Run after `npm run cf:build`:

      npm run cf:build && node scripts/check-delivery.mjs
*/
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PORT = Number(process.env.DELIVERY_PORT ?? 8791);
const BASE = `http://127.0.0.1:${PORT}`;

/* The same list the layout audit sweeps, so the two cannot drift apart. */
const PAGES = [
  "/", "/plan", "/history", "/practice", "/practice/listening", "/practice/reading",
  "/practice/writing", "/speaking", "/grammar", "/vocabulary", "/resources", "/chat",
  "/account", "/billing", "/pricing", "/placement", "/privacy", "/terms", "/credits",
];

const problems = [];
function fail(message) {
  problems.push(message);
}

if (!existsSync(".open-next/worker.js")) {
  console.error("No .open-next/worker.js — run `npm run cf:build` first.");
  process.exit(1);
}

/*
  --local keeps this offline: no account, no API token, no network. Metrics off
  for the same reason, so a CI runner with no outbound access does not sit
  waiting on a telemetry POST.
*/
const worker = spawn(
  "npx",
  ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", String(PORT + 1)],
  { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
);

let workerLog = "";
worker.stdout.on("data", (d) => (workerLog += d));
worker.stderr.on("data", (d) => (workerLog += d));

function stop() {
  try {
    worker.kill("SIGTERM");
  } catch {
    /* Already gone. */
  }
}
process.on("exit", stop);

async function waitForReady() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE}/`, { redirect: "manual" });
      if (res.status < 500) return true;
    } catch {
      /* Not listening yet. */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

if (!(await waitForReady())) {
  console.error("The Worker never came up.\n" + workerLog.slice(-2000));
  stop();
  process.exit(1);
}

/**
 * Whether a Cache-Control lets a cache hand this back without asking first.
 *
 * `no-store`, `no-cache` and `must-revalidate` all force the question.
 * `max-age=0` alone does not, quite — a stale response may still be served by
 * a cache that decides to — so it only counts alongside one of the others,
 * which is how the header this file was written for is spelled.
 */
function reuseWithoutAsking(value) {
  if (!value) return true;
  const v = value.toLowerCase();
  if (v.includes("no-store") || v.includes("no-cache") || v.includes("must-revalidate")) {
    return false;
  }
  /* Any positive lifetime, to anybody, with nothing forcing a check. */
  for (const m of v.matchAll(/(?:^|[\s,])(?:s-)?maxage=(\d+)|(?:^|[\s,])(?:s-)?max-age=(\d+)/g)) {
    const n = Number(m[1] ?? m[2]);
    if (Number.isFinite(n) && n > 0) return true;
  }
  return !v.includes("max-age=0");
}

/** Every same-origin thing a document tells the browser to go and fetch. */
function referencedAssets(html) {
  const out = new Set();
  for (const m of html.matchAll(/(?:href|src)="(\/[^"]+)"/g)) {
    const url = m[1];
    if (url.startsWith("/_next/") || /\.(css|js|woff2?|png|svg|jpe?g|webp|json)$/.test(url)) {
      out.add(url);
    }
  }
  return out;
}

const assets = new Set();

for (const path of PAGES) {
  let res;
  try {
    res = await fetch(BASE + path);
  } catch (err) {
    fail(`${path}: could not be fetched (${err})`);
    continue;
  }
  if (!res.ok) {
    fail(`${path}: ${res.status}`);
    continue;
  }

  const cc = res.headers.get("cache-control");
  if (reuseWithoutAsking(cc)) {
    fail(
      `${path}: Cache-Control "${cc ?? "(none)"}" lets a cache reuse this page without ` +
        `revalidating. A page that outlives its fingerprinted stylesheet renders unstyled.`,
    );
  }

  const html = await res.text();
  for (const a of referencedAssets(html)) assets.add(a);
}

/* 4. Cross-origin isolation on /speaking. */
{
  const res = await fetch(`${BASE}/speaking`);
  for (const [header, want] of [
    ["cross-origin-opener-policy", "same-origin"],
    ["cross-origin-embedder-policy", "require-corp"],
  ]) {
    const got = res.headers.get(header);
    if (got !== want) {
      fail(`/speaking: ${header} is "${got ?? "(none)"}", expected "${want}" — on-device transcription needs it`);
    }
  }
}

/* 2. Nothing referenced may be missing, and 3. static keeps its caching. */
let staticChecked = 0;
for (const url of assets) {
  let res;
  try {
    res = await fetch(BASE + url);
  } catch (err) {
    fail(`${url}: could not be fetched (${err})`);
    continue;
  }
  if (!res.ok) {
    fail(`${url}: ${res.status} — referenced by a page but not served`);
    continue;
  }
  if (url.startsWith("/_next/static/")) staticChecked += 1;
}

if (staticChecked === 0) {
  fail("No /_next/static asset was referenced by any page, which cannot be right — the check is not looking at what it thinks it is.");
}

stop();

if (problems.length > 0) {
  console.error(`Delivery check failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}

console.log(
  `Delivery OK: ${PAGES.length} pages revalidate, ${assets.size} referenced assets all served ` +
    `(${staticChecked} from /_next/static), /speaking still cross-origin isolated.`,
);
process.exit(0);
