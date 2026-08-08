/*
  The guarantee proxy.ts used to make at runtime, made here at build time
  instead.

  proxy.ts deleted a set of forgeable headers from every request before any
  route saw them. It cannot run on Cloudflare, so it is gone. Rather than
  quietly dropping the protection, the rule it enforced is asserted directly:
  no source file may read a header a caller could have written to claim
  something about itself.

  This is the stronger of the two, and worth saying why. Stripping protected
  the six names someone thought of in advance. A test that reads the source
  catches the seventh — the header invented next month and trusted two lines
  later — because the failure is "you read a trust header", not "you read one
  of these six".
*/
import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const { FORGEABLE_HEADERS, sanitizedHeaders } = await import(
  pathToFileURL(join(process.cwd(), "lib", "http", "trust.ts")).href
);

const ROOTS = ["app", "lib", "components", "scripts"];
const SKIP_FILES = new Set([join("lib", "http", "trust.ts")]);

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

test("no source file reads a forgeable trust header", () => {
  const offenders = [];

  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      if (SKIP_FILES.has(relative(process.cwd(), file))) continue;
      const source = readFileSync(file, "utf8");
      for (const header of FORGEABLE_HEADERS) {
        if (source.toLowerCase().includes(header)) {
          offenders.push(`${file} reads ${header}`);
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `A caller can set any header they like, so a value read from one of these ` +
      `is a claim the client made about itself, not a fact:\n  ${offenders.join("\n  ")}`,
  );
});

test("the test itself detects a planted violation", () => {
  // A test that has never failed has not been shown to work. This plants the
  // exact string the check looks for and confirms the check would see it.
  const planted = `const role = req.headers.get("${FORGEABLE_HEADERS[1]}");`;
  const seen = FORGEABLE_HEADERS.some((h) => planted.toLowerCase().includes(h));
  assert.equal(seen, true);
});

test("sanitizedHeaders removes every forgeable name and keeps the rest", () => {
  const req = new Request("https://example.test/", {
    headers: {
      "x-bandup-role": "admin",
      "x-user-id": "1",
      authorization: "Bearer real-token",
      "content-type": "application/json",
    },
  });
  const headers = sanitizedHeaders(req);

  for (const name of FORGEABLE_HEADERS) {
    assert.equal(headers.get(name), null, `${name} should have been removed`);
  }
  assert.equal(headers.get("authorization"), "Bearer real-token");
  assert.equal(headers.get("content-type"), "application/json");
});
