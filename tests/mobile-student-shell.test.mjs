/*
  The static-export failure this guards against:

    Error: Page "/organization/students/[id]" is missing
    "generateStaticParams()" so it cannot be used with "output: export"
    config.

  HANDOVER.md is explicit that the fix is not to delete the two dynamic
  organisation-student pages from the iOS bundle — that would silently remove
  teacher/student-history functionality from the app. The fix instead is:

    - the website keeps its path routes, unchanged;
    - the iOS bundle gets two static query-shell routes with no dynamic
      segment, serving the same two screens from `?student=...` /
      `?attempt=...` instead of from `[id]` / `[attemptId]`;
    - lib/organizations/student-links.ts is the one place that knows which
      form to build, so every link (and the one server-built notification
      link that has to be rewritten after the fact) goes through it.

  This runs the website side for real, and — for the mobile side — spawns a
  fresh process with NEXT_PUBLIC_MOBILE_BUILD=1 (tests/mobile-build-probe.mjs)
  rather than reading source. IS_MOBILE_BUILD is read from that env var once,
  at module load (see lib/platform.ts), so a plain `node --test` run cannot
  flip it after the fact by re-importing: this was checked by hand — three
  imports of the same file under three different `?query` suffixes, with the
  env var changed before each, all still answered with the first import's
  value. A separate process is what actually observes the second branch.
*/
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { register } from "node:module";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const ROOT = process.cwd();
const load = (...parts) => import(pathToFileURL(join(ROOT, ...parts)).href);

const links = await load("lib", "organizations", "student-links.ts");
const linksSource = readFileSync(join(ROOT, "lib", "organizations", "student-links.ts"), "utf8");

/** Runs tests/mobile-build-probe.mjs in a fresh process and parses its JSON. */
function mobileBuildOutputs() {
  const stdout = execFileSync(
    process.execPath,
    [join(ROOT, "tests", "mobile-build-probe.mjs")],
    { cwd: ROOT, env: { ...process.env, NEXT_PUBLIC_MOBILE_BUILD: "1" }, encoding: "utf8" },
  );
  return JSON.parse(stdout);
}

test("studentHistoryHref builds the website path form, with its optional params", () => {
  assert.equal(links.studentHistoryHref("stu-1"), "/organization/students/stu-1");
  assert.equal(
    links.studentHistoryHref("stu-1", { organizationId: "org-1", previewRole: "manager" }),
    "/organization/students/stu-1?organization=org-1&preview=manager",
  );
  // Only the id is a literal interpolation; it goes through encodeURIComponent
  // the way every existing call site already builds this path.
  assert.equal(links.studentHistoryHref("stu 1"), "/organization/students/stu%201");
});

test("sittingReviewHref builds the website path form, with its optional params", () => {
  assert.equal(links.sittingReviewHref("stu-1", "att-1"), "/organization/students/stu-1/sittings/att-1");
  assert.equal(
    links.sittingReviewHref("stu-1", "att-1", {
      organizationId: "org-1",
      from: "assignment-directory",
      focus: "assignment-completed",
      previewRole: "teacher",
    }),
    "/organization/students/stu-1/sittings/att-1"
      + "?organization=org-1&from=assignment-directory&focus=assignment-completed&preview=teacher",
  );
  assert.equal(
    links.sittingReviewHref("stu 1", "att 1"),
    "/organization/students/stu%201/sittings/att%201",
  );
});

test("normaliseStudentHref is identity on the website build", () => {
  assert.equal(links.normaliseStudentHref("/organization/students/stu-1"), "/organization/students/stu-1");
  assert.equal(
    links.normaliseStudentHref("/organization/students/stu-1/sittings/att-1?organization=org-1&focus=assignment-completed"),
    "/organization/students/stu-1/sittings/att-1?organization=org-1&focus=assignment-completed",
  );
  // Nothing that isn't one of these two shapes is touched, on either build.
  assert.equal(links.normaliseStudentHref("/organization?section=assignments"), "/organization?section=assignments");
});

test("the mobile branch builds the query-shell form", () => {
  assert.match(linksSource, /IS_MOBILE_BUILD/);
  assert.match(linksSource, /\/organization\/student\?student=/);
  assert.match(linksSource, /\/organization\/student\/sitting\?student=/);
  assert.match(linksSource, /&attempt=/);
  // The two shapes normaliseStudentHref rewrites a website path into, once
  // IS_MOBILE_BUILD is set, are the very same two route strings.
  assert.match(linksSource, /"\/organization\/student\/sitting"/);
  assert.match(linksSource, /"\/organization\/student"/);
});

test("studentHistoryHref and sittingReviewHref build the query-shell form for real on the mobile build", () => {
  const out = mobileBuildOutputs();
  assert.equal(out.studentHistoryHrefPlain, "/organization/student?student=stu-1");
  assert.equal(
    out.studentHistoryHrefWithOpts,
    "/organization/student?student=stu-1&organization=org-1&preview=manager",
  );
  assert.equal(out.sittingReviewHrefPlain, "/organization/student/sitting?student=stu-1&attempt=att-1");
  assert.equal(
    out.sittingReviewHrefWithOpts,
    "/organization/student/sitting?student=stu-1&attempt=att-1"
      + "&organization=org-1&from=assignment-directory&focus=assignment-completed&preview=teacher",
  );
});

test("normaliseStudentHref rewrites a website path into the query-shell form for real on the mobile build", () => {
  const out = mobileBuildOutputs();
  assert.equal(out.normalisePlainStudent, "/organization/student?student=stu-1");
  assert.equal(
    out.normaliseSittingWithQuery,
    "/organization/student/sitting?student=stu-1&attempt=att-1&organization=org-1&focus=assignment-completed",
  );
  // The regex is anchored at both ends: content before the known shape (not
  // matched by the leading `^`) or after it (not matched by the trailing `$`)
  // must leave the href untouched rather than transforming a false positive
  // or silently dropping a suffix it does not understand.
  assert.equal(out.normaliseLeadingGarbage, "xxx/organization/students/stu-1");
  assert.equal(out.normaliseTrailingGarbage, "/organization/students/stu-1/extra-junk");
  // And a path that isn't one of the two known shapes at all is untouched,
  // on the mobile build exactly as on the website (see the identity test
  // above) — this is the one case both builds must agree on.
  assert.equal(out.normaliseUnrelated, "/organization?section=assignments");
});

test("scripts/build-mobile.mjs excludes the dynamic student tree from the iOS bundle", () => {
  const source = readFileSync(join(ROOT, "scripts", "build-mobile.mjs"), "utf8");
  assert.match(
    source,
    /join\("app", "organization", "students"\)/,
    "app/organization/students must stay out of the iOS export — it has dynamic segments output: export cannot build",
  );
});

test("both static shell routes exist and carry no dynamic segment", () => {
  const shellFiles = [
    "app/organization/student/page.tsx",
    "app/organization/student/sitting/page.tsx",
  ];
  for (const rel of shellFiles) {
    const full = join(ROOT, ...rel.split("/"));
    assert.ok(existsSync(full), `${rel} should exist`);
    assert.ok(!rel.includes("["), `${rel} must not contain a dynamic segment`);
  }
});

test("each shell wraps useSearchParams() in a Suspense boundary", () => {
  // The server half (this file) exports metadata and renders the client half
  // inside <Suspense>; the client half (which useSearchParams needs, being a
  // client-only hook) is its sibling. Both together are "the shell".
  const pairs = [
    ["app/organization/student/page.tsx", "app/organization/student/StudentQueryShell.tsx"],
    ["app/organization/student/sitting/page.tsx", "app/organization/student/sitting/SittingQueryShell.tsx"],
  ];
  for (const [pagePath, shellPath] of pairs) {
    const page = readFileSync(join(ROOT, ...pagePath.split("/")), "utf8");
    const shell = readFileSync(join(ROOT, ...shellPath.split("/")), "utf8");
    assert.match(page, /export const metadata/, `${pagePath} must export metadata (a server component)`);
    assert.doesNotMatch(page, /^"use client";/m, `${pagePath} must stay a server component`);
    assert.match(page, /<Suspense/, `${pagePath} must wrap its query-reading child in Suspense`);
    assert.match(shell, /^"use client";/m, `${shellPath} must be a client component`);
    assert.match(shell, /useSearchParams\(/, `${shellPath} must read the query with useSearchParams`);
  }
});

test("the two dynamic website pages still exist — the fix did not delete web functionality", () => {
  const dynamicFiles = [
    join(ROOT, "app", "organization", "students", "[id]", "page.tsx"),
    join(ROOT, "app", "organization", "students", "[id]", "sittings", "[attemptId]", "page.tsx"),
  ];
  for (const full of dynamicFiles) {
    assert.ok(existsSync(full), `${relative(ROOT, full)} should still exist — the website keeps its own path route`);
  }
});

/** Every .tsx under dir. */
function tsxFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

test("no organization component hand-builds a raw /organization/students/ page link any more", () => {
  const dir = join(ROOT, "components", "organization");
  const offenders = [];
  for (const file of tsxFiles(dir)) {
    const source = readFileSync(file, "utf8");
    // The /api/organization/students/<id> fetches are a different thing
    // entirely — data requests, not page links — and are untouched by this.
    const withoutApiFetches = source.replaceAll("/api/organization/students/", "");
    if (withoutApiFetches.includes("/organization/students/")) {
      offenders.push(relative(ROOT, file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these still hand-build a raw /organization/students/ URL instead of using lib/organizations/student-links.ts:\n  ${offenders.join("\n  ")}`,
  );
});
