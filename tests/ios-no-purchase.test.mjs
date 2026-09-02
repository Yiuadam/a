/*
  The iOS bundle must contain no way to buy anything.

  Apple requires digital content used inside an iOS app to be sold through
  In-App Purchase, and takes 30% of what is sold that way. BandUp's answer is
  that the iOS app sells nothing at all: subscriptions are bought on the web,
  and the app only signs in. That is a compliance position rather than a
  preference, and it fails in a way nobody would notice locally — the web build
  keeps working perfectly while the thing that ships to review has a Subscribe
  button on it.

  So it is checked here instead, statically, in the two places it can break:

    the build script stops moving the billing routes out of the export, or
    a new link to one of them is added without the guard that hides it.

  Static rather than by building: `npm run build:mobile` takes minutes and is
  already in CI. This runs in milliseconds on every `npm test`, which is where
  somebody adding a "Subscribe" button will actually meet it.

  ---------------------------------------------------------------------------
  The app may now link out — from some countries

  A US court held Apple in contempt in April 2025 over the part of 3.1.1 that
  bans linking to an external purchase page, and Apple changed the US
  guidelines the next day. So the app does link to bandup.life, but only on the
  storefronts where that is lawful; everywhere else it still says the sentence
  and offers nothing to press.

  That gate is now the thing most worth protecting, and it is easy to lose by
  accident: deleting one condition turns a US-only link into a worldwide one,
  which looks correct in every simulator and is a rejection in Hong Kong. The
  two tests at the bottom hold the shape of it.
*/
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

test("the build script keeps server-only and billing routes out of the bundle", () => {
  const source = readFileSync(join(ROOT, "scripts", "build-mobile.mjs"), "utf8");
  for (const dir of ["api", "admin", "pricing", "billing"]) {
    assert.match(
      source,
      new RegExp(`join\\("app", "${dir}"\\)`),
      `app/${dir} is no longer excluded from the iOS export`,
    );
  }
  assert.match(
    source,
    /NEXT_PUBLIC_MOBILE_BUILD: "1"/,
    "the mobile build no longer sets the flag the interface reads",
  );
});

test("the website owner console is absent from mobile navigation", () => {
  const source = readFileSync(join(ROOT, "components", "SiteHeader.tsx"), "utf8");
  assert.match(
    source,
    /const groups = isOwner && !IS_MOBILE_BUILD/,
    "the static iOS bundle must not link to its excluded website-only owner console",
  );
});

/** Every .ts/.tsx under the app's own source, ignoring build output. */
function sources(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/*
  The pages themselves are exempt: they are the thing being removed, so they are
  not in the bundle to link from. Everything else that names one has to be able
  to draw itself without it.
*/
const EXEMPT = ["app/pricing", "app/billing"];

test("nothing links to a billing route without hiding it on iOS", () => {
  const offenders = [];
  for (const dir of ["app", "components", "lib"]) {
    for (const file of sources(join(ROOT, dir))) {
      const rel = relative(ROOT, file).replace(/\\/g, "/");
      if (EXEMPT.some((e) => rel.startsWith(e))) continue;
      const source = readFileSync(file, "utf8");
      if (!/["'`]\/(pricing|billing)["'`]/.test(source)) continue;
      if (!source.includes("IS_MOBILE_BUILD")) offenders.push(rel);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these point at a billing route with nothing to hide it in the iOS build:\n  ${offenders.join(
      "\n  ",
    )}`,
  );
});

test("the flag is read from the environment, never hard-coded", () => {
  const source = readFileSync(join(ROOT, "lib", "platform.ts"), "utf8");
  assert.match(
    source,
    /process\.env\.NEXT_PUBLIC_MOBILE_BUILD === "1"/,
    "IS_MOBILE_BUILD must come from the build environment",
  );
  /*
    NEXT_PUBLIC_ on purpose: this decides what is *drawn*, so it has to survive
    into the client bundle. It holds nothing secret — it is the string "1" — and
    tests/no-secret-leak.test.mjs is what guards the names that do.
  */
  assert.ok(
    !/SECRET|KEY|TOKEN/.test(source),
    "lib/platform.ts must not name a secret; it ships to the browser",
  );
});

test("the external link is gated on the storefront, and starts closed", () => {
  const source = readFileSync(join(ROOT, "lib", "billing", "storefront.ts"), "utf8");

  assert.match(
    source,
    /EXTERNAL_LINK_STOREFRONTS\.has\(/,
    "the plans URL must be gated on the storefront allow-list, not returned unconditionally",
  );

  /*
    The default has to be "no link", because the first render happens before
    StoreKit has answered. Starting at `true` would show the link everywhere
    for a frame and then withdraw it — visible, wrong, and worst on the one
    device where somebody is deciding whether to approve the app.
  */
  assert.match(
    source,
    /useState\(false\)/,
    "useExternalPlansUrl must start with no link and only ever open, never close",
  );
});

test("nothing builds an external plans URL without asking whether it may", () => {
  const offenders = [];
  for (const dir of ["app", "components", "lib"]) {
    for (const file of sources(join(ROOT, dir))) {
      const rel = relative(ROOT, file).replace(/\\/g, "/");
      if (rel === "lib/billing/storefront.ts") continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes("ExternalPlansLink")) continue;
      /*
        The component itself is the renderer and takes the URL as a prop; every
        other file that names it has to have got that URL from the hook, which
        is the only thing that consults the storefront.
      */
      if (rel === "components/billing/ExternalPlansLink.tsx") continue;
      if (!source.includes("useExternalPlansUrl")) offenders.push(rel);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these link out of the app without going through the storefront gate:\n  ${offenders.join(
      "\n  ",
    )}`,
  );
});
