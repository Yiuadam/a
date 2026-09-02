import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");

const platform = read("lib", "platform.ts");
const config = read("miniprogram", "config.js");
const page = read("miniprogram", "pages", "index", "index.js");
const appJson = JSON.parse(read("miniprogram", "app.json"));
const refraction = read("components", "GlassRefractionFilter.tsx");

test("the shell announces itself in the language the site reads", () => {
  /*
    Two halves of one handshake, in two languages that no compiler checks
    against each other: the mini program is plain JavaScript that WeChat
    packs, and the site is TypeScript that Next builds. Nothing but this
    connects them, and a drift between them fails silently — the shell opens,
    the site loads, and the only symptom is that the glass everyone agreed to
    switch off inside a web-view is still running.
  */
  const declared = platform.match(/export const MINIPROGRAM_SHELL = "([^"]+)"/);
  assert.ok(declared, "lib/platform.ts should declare the shell marker");
  const stamped = config.match(/SHELL_MARKER: "([^"]+)"/);
  assert.ok(stamped, "miniprogram/config.js should carry the shell marker");
  assert.equal(stamped[1], declared[1]);

  // The page has to actually put it in the URL, not merely import it.
  assert.match(page, /shell=\$\{SHELL_MARKER\}/);

  // https, and no trailing slash: the page concatenates a path onto this, and
  // WeChat will not accept a business domain that is not https.
  const origin = config.match(/SITE_ORIGIN: "([^"]+)"/);
  assert.ok(origin, "miniprogram/config.js should name an origin");
  assert.match(origin[1], /^https:\/\/[^/]+$/);
});

test("the marker outlives the first page, and an unreadable store is not an answer", () => {
  /*
    Only the page the mini program opens carries the query string. Every link
    followed from it is an ordinary in-app navigation, so without remembering
    it the site would look like a plain browser again partway through a
    session and the lens would come back mid-use.
  */
  assert.match(platform, /window\.sessionStorage\.setItem\(MINIPROGRAM_SHELL_STORE, "1"\);/);
  assert.match(platform, /window\.sessionStorage\.getItem\(MINIPROGRAM_SHELL_STORE\) === "1"/);

  // Embedded web-views and private modes throw on storage rather than return
  // null, and a throw is not evidence either way — the other two signals have
  // already had their say by then.
  assert.match(platform, /\} catch \{[\s\S]*?return false;/);

  // Three signals, because each one alone has a hole: __wxjs_environment is
  // set by a bridge script that can land after first paint, and the user
  // agent does not carry the marker on every client.
  assert.match(platform, /__wxjs_environment === "miniprogram"/);
  assert.match(platform, /\/miniprogram\/i\.test\(navigator\.userAgent\)/);
});

test("a path arriving from a share link cannot send the web-view off-site", () => {
  /*
    `path` reaches the shell from a scene value or a share, which is to say
    from outside. A protocol-relative "//evil.example" is a whole other origin
    wearing the shape of a path, and the shell would concatenate it onto the
    origin and navigate there.
  */
  assert.match(page, /\/\^\\\/\(\?!\\\/\)\[\\w\\-\/\]\*\$\//);
  assert.match(page, /: "\/";/);

  const guard = /^\/(?!\/)[\w\-/]*$/;
  for (const hostile of ["//evil.example", "https://evil.example", "javascript:alert(1)", "\\/\\/evil"]) {
    assert.equal(guard.test(hostile), false, `${hostile} should not be accepted as a path`);
  }
  for (const allowed of ["/", "/writing", "/practice/listening"]) {
    assert.equal(guard.test(allowed), true, `${allowed} should be accepted`);
  }
});

test("the lens declines inside the shell, through the gate both engines share", () => {
  // The shell is not a weaker device — the same bundle serves a desktop
  // browser — so no capability check would decline it. It is declined because
  // a lens bends what is behind it and inside a web-view that is another
  // app's chrome.
  assert.match(refraction, /if \(isMiniProgramShell\(\)\) return false;/);
  /*
    Matched as one name among however many the import happens to carry, rather
    than as the exact line it used to be. What this test is about is that the
    shell check comes from lib/platform and is actually called; it broke when a
    second name was added beside it, which told us nothing about the shell and
    only that somebody had edited a neighbouring import.
  */
  assert.match(
    refraction,
    /import \{[^}]*\bisMiniProgramShell\b[^}]*\} from "@\/lib\/platform";/,
  );

  /*
    And through lensPreferencesAllow, which the split path now calls instead
    of repeating its three checks. The two paths are one decision about
    whether a lens is wanted and only then a decision about which engine draws
    it; spelled out twice, they could decline apart.
  */
  const split = refraction.match(/function supportsSplitPropertyLens\(\) \{[\s\S]*?\n\}/);
  assert.ok(split, "expected supportsSplitPropertyLens");
  assert.match(split[0], /return lensPreferencesAllow\(\);/);
  assert.doesNotMatch(split[0], /REDUCED_MOTION_QUERY/);

  /*
    And the heaviest path says it outright rather than letting the capability
    gate arrive at the same answer by accident. It would: a web-view is a
    coarse pointer and finePointer is the first thing supportsDetailedGlass
    asks about. But that is a fact about phones, not a decision about the
    shell — measured on a desktop browser carrying the marker, the split lens
    declined and this one stayed on until it was asked directly.
  */
  const live = refraction.match(/function supportsDetailedLiveRefraction\(\) \{[\s\S]*?\n\}/);
  assert.ok(live, "expected supportsDetailedLiveRefraction");
  assert.match(live[0], /if \(isMiniProgramShell\(\)\) return false;/);
});

test("the shell is one page, and every file WeChat needs for it is present", () => {
  assert.deepEqual(appJson.pages, ["pages/index/index"]);
  for (const file of [
    ["miniprogram", "app.js"],
    ["miniprogram", "app.wxss"],
    ["miniprogram", "sitemap.json"],
    ["miniprogram", "project.config.json"],
    ["miniprogram", "pages", "index", "index.json"],
    ["miniprogram", "pages", "index", "index.wxml"],
    ["miniprogram", "pages", "index", "index.wxss"],
  ]) {
    assert.doesNotThrow(() => read(...file), `${file.join("/")} should exist`);
  }

  // A web-view given an empty src navigates to nothing and then has to be
  // navigated again, which shows as a flash of blank followed by a reload.
  assert.match(read("miniprogram", "pages", "index", "index.wxml"), /wx:if="\{\{url\}\}"/);
});
