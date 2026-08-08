#!/usr/bin/env node
/*
  Sweeps every page at several widths and reports two things a build can never
  catch: text painted on top of a control, and a page that scrolls sideways.

  Why this exists
  ---------------
  The header nav overflowed for weeks and nothing failed. eslint was clean,
  the build was clean, every test passed, and the only symptom was that
  "Ask a tutor" and "Guides" were drawn over the account button — at every
  width, including a 1440px monitor. A flex row that runs out of room overflows
  *visibly* rather than wrapping or clipping, so there is no error to raise and
  no overflow to measure on the element itself. It looks fine to every tool and
  wrong to every person.

  It also found, on the same run, that every page in the app scrolled sideways
  by 17px at exactly 768px — the width where the old row appeared and instantly
  outgrew its container. Nobody had noticed, because you have to be at that
  width, on any page, and looking for it.

  How it detects an overlap
  -------------------------
  Hit-testing, not geometry. For each piece of visible text, the midpoint of
  its box is handed to elementFromPoint; if what comes back is not that element
  or one of its relatives, something is painted on top of it. That is exactly
  what a person sees, which is the point — it does not care *why* the boxes
  intersect, only that one is covering the other.

  Not wired into CI
  -----------------
  It needs a browser and a running dev server, which would make every CI run
  slower and flakier for a check that catches a rare class of bug. Run it by
  hand when you touch layout:

      npm run dev
      node scripts/audit-layout.mjs

  Playwright is not a dependency of this project — it is expected to be
  available globally or via npx. If it is missing this exits 0 with a loud
  message rather than failing, so it can be dropped into a script without
  becoming a hard dependency of anything.
*/

const BASE = process.env.BASE_URL || "http://localhost:3000";

const PAGES = [
  "/", "/plan", "/history", "/practice", "/practice/listening", "/practice/reading",
  "/practice/writing", "/speaking", "/grammar", "/vocabulary", "/resources", "/chat",
  "/account", "/billing", "/pricing", "/placement", "/privacy", "/terms",
];

/*
  The widths are chosen, not sampled. 390 and 430 are the two commonest iPhone
  widths; 768 and 1024 are the exact breakpoints, which is where a layout
  changes its mind and therefore where it breaks; 1280 and 1440 are ordinary
  laptop and desktop.
*/
const WIDTHS = [390, 430, 768, 1024, 1280, 1440];

/*
  Finding a Playwright that can actually launch.

  Resolving the module is not the same as being able to use it, and the
  difference bites here: this project resolves a Playwright whose browser build
  was never downloaded, so `import` succeeds and `launch()` throws with a
  message telling you to run `npx playwright install`. A globally installed
  copy with its browsers present sits right next to it and works fine.

  So each candidate is tried by launching it, not by importing it, and the
  first browser that actually starts is the one used. Anything else is a check
  that passes locally and fails on someone else's machine for a reason the
  error message buries.
*/
async function launchBrowser() {
  const candidates = [];

  try {
    candidates.push(["project", await import("playwright")]);
  } catch {
    /* not installed here; that is normal — it is not a dependency */
  }

  try {
    const { execSync } = await import("node:child_process");
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const root = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    candidates.push(["global", await import(pathToFileURL(join(root, "playwright", "index.mjs")).href)]);
  } catch {
    /* no global install either */
  }

  for (const [where, mod] of candidates) {
    try {
      return { browser: await mod.chromium.launch(), where };
    } catch {
      /* this copy has no browser downloaded — try the next */
    }
  }
  return null;
}

const launched = await launchBrowser();
if (!launched) {
  console.log("No Playwright with a working browser was found — skipping the layout audit.");
  console.log("Install one (npm i -D playwright && npx playwright install chromium) to run this.");
  process.exit(0);
}
const { browser } = launched;

const page = await browser.newPage();
let problems = 0;

for (const width of WIDTHS) {
  await page.setViewportSize({ width, height: 900 });
  for (const path of PAGES) {
    const response = await page.goto(BASE + path, { waitUntil: "networkidle" }).catch(() => null);
    if (!response || response.status() >= 400) {
      console.log(`  ${String(width).padEnd(5)} ${path.padEnd(22)} HTTP ${response?.status() ?? "unreachable"}`);
      problems++;
      continue;
    }
    await page.waitForTimeout(120);

    const found = await page.evaluate(() => {
      const out = {
        sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        overlaps: [],
      };

      const leaves = [...document.querySelectorAll("a, button, h1, h2, h3, p, span, li, td, th, label")]
        .filter((el) => {
          // Leaves only: a <p> wrapping a <span> would report its child covering it.
          if (el.querySelector("a,button,h1,h2,h3,p,span,li,td,th,label")) return false;
          if (!(el.textContent || "").trim()) return false;
          const s = getComputedStyle(el);
          if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return false;
          const b = el.getBoundingClientRect();
          if (b.width <= 4 || b.height <= 4) return false;
          // The midpoint must be on screen for elementFromPoint to mean anything.
          const cx = b.left + b.width / 2;
          const cy = b.top + b.height / 2;
          return cx >= 0 && cx <= innerWidth && cy >= 0 && cy <= innerHeight;
        });

      for (const el of leaves) {
        const b = el.getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
        /*
          A cover with no text and no interaction of its own is decoration —
          an overlay, a gradient, a focus ring. Those sit over things on
          purpose and are not what this is looking for.
        */
        if (!(hit.textContent || "").trim() && !hit.matches("a,button,input,select,textarea")) continue;
        out.overlaps.push({
          text: (el.textContent || "").trim().slice(0, 40),
          covering:
            hit.tagName.toLowerCase() +
            (typeof hit.className === "string" && hit.className
              ? `.${hit.className.split(/\s+/).slice(0, 2).join(".")}`
              : ""),
        });
      }
      return out;
    });

    if (found.sideways > 0) {
      console.log(`  ${String(width).padEnd(5)} ${path.padEnd(22)} scrolls sideways by ${found.sideways}px`);
      problems++;
    }
    for (const o of found.overlaps.slice(0, 4)) {
      console.log(`  ${String(width).padEnd(5)} ${path.padEnd(22)} "${o.text}" is covered by <${o.covering}>`);
      problems++;
    }
  }
}

await browser.close();

if (problems === 0) {
  console.log(`Layout OK: ${PAGES.length} pages × ${WIDTHS.length} widths, no overlaps and no sideways scroll.`);
  process.exit(0);
}
console.log(`\n${problems} layout problem(s) across ${PAGES.length} pages × ${WIDTHS.length} widths.`);
process.exit(1);
