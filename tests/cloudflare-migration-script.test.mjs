import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { hash, json } from "../scripts/migration-hash.mjs";

const source = readFileSync(
  join(process.cwd(), "scripts", "migrate-supabase-to-cloudflare.mjs"),
  "utf8",
);

test("the retired production copy runner stops before touching live data", () => {
  const result = spawnSync(
    "bash",
    [join(process.cwd(), "scripts", "run-production-cloudflare-migration.sh")],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        SUPABASE_URL: "https://example.invalid",
        SUPABASE_SERVICE_ROLE_KEY: "not-a-real-key",
      },
    },
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /pre-cutover only/);
  assert.match(result.stderr, /already Cloudflare-authoritative/);
  assert.doesNotMatch(result.stderr, /Running a source-read-only production dry run/);
});

test("invalid migration invocation fails with the intended safe CLI message", () => {
  const result = spawnSync(
    process.execPath,
    [join(process.cwd(), "scripts", "migrate-supabase-to-cloudflare.mjs")],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        SUPABASE_URL: "",
        SUPABASE_SERVICE_ROLE_KEY: "",
      },
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Migration stopped: choose exactly one target: --preview or --production/);
  assert.doesNotMatch(result.stderr, /ReferenceError|before initialization/);
});

test("single D1 statements use command mode while only bulk pages use file imports", () => {
  const executeSql = source.match(
    /async function executeSql\(statement\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? "";
  const executeSqlFile = source.match(
    /async function executeSqlFile\(path, capture = false\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? "";

  assert.match(executeSql, /"--command", statement/);
  assert.doesNotMatch(executeSql, /"--file"/);
  assert.match(executeSqlFile, /"--file", path/);
});

test("migration verification requires a complete unique page and matching hashes", () => {
  assert.match(source, /found\.length !== expected\.length/);
  assert.match(source, /foundById\.size !== expected\.length/);
  assert.match(source, /row\.source_sha256 !== item\.digest/);
  assert.match(source, /bytes\.length !== Number\(row\.source_bytes\)/);
});

test("migration hashes Buffer and Uint8Array values as raw bytes", () => {
  const bytes = [0x00, 0x01, 0x02, 0xff];
  const expected = "3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56";

  assert.equal(hash(Buffer.from(bytes)), expected);
  assert.equal(hash(new Uint8Array(bytes)), expected);
});

test("migration hashes ordinary JSON through its canonical representation", () => {
  const value = { z: 1, a: { y: 2, x: [3, 1] } };
  const reordered = { a: { x: [3, 1], y: 2 }, z: 1 };
  const canonicalJson = '{"a":{"x":[3,1],"y":2},"z":1}';
  const expected = "311c10ef286bfe1ee807ad5c68b930e534c172adfb3d57d52546837daf0edbc1";

  assert.equal(json(value), canonicalJson);
  assert.equal(hash(value), expected);
  assert.equal(hash(reordered), expected);
});

test("practice-attempt migration records review metadata and preserves detailed payloads", () => {
  const descriptor = source.match(
    /source: "practice_attempts",[\s\S]*?source: "organization_attempt_archives"/,
  )?.[0] ?? "";

  assert.match(descriptor, /typeof row\.payload\.review === "object"/);
  assert.match(descriptor, /result_has_review/);
  for (const column of [
    "result_inline",
    "result_object_key",
    "result_sha256",
    "result_bytes",
  ]) {
    assert.match(
      descriptor,
      new RegExp(
        `${column}=CASE WHEN practice_attempts\\.result_has_review=1 AND excluded\\.result_has_review=0 THEN practice_attempts\\.${column} ELSE excluded\\.${column} END`,
      ),
    );
  }
  assert.match(
    descriptor,
    /result_has_review=max\(practice_attempts\.result_has_review,excluded\.result_has_review\)/,
  );
});

test("preview copies use the private migration config, never the public role preview", () => {
  const migrationConfig = readFileSync(
    join(process.cwd(), "wrangler.migration-preview.jsonc"),
    "utf8",
  );
  const publicPreviewConfig = readFileSync(
    join(process.cwd(), "wrangler.preview.jsonc"),
    "utf8",
  );

  assert.match(source, /wrangler\.migration-preview\.jsonc/);
  assert.doesNotMatch(source, /productionTarget \? "wrangler\.jsonc" : "wrangler\.preview\.jsonc"/);
  assert.match(migrationConfig, /"database_name": "bandup-data-preview"/);
  assert.match(migrationConfig, /"bucket_name": "bandup-files-preview"/);
  assert.doesNotMatch(migrationConfig, /organization-preview\.bandup\.life|ORGANIZATION_UI_PREVIEW/);
  assert.match(publicPreviewConfig, /"database_name": "bandup-organization-ui-preview"/);
  assert.doesNotMatch(publicPreviewConfig, /"database_name": "bandup-data-preview"/);
  const rehearsal = readFileSync(
    join(process.cwd(), "scripts", "rehearse-cloudflare-migration.mjs"),
    "utf8",
  );
  assert.match(rehearsal, /wrangler\.migration-preview\.jsonc/g);
  assert.doesNotMatch(rehearsal, /wrangler\.preview\.jsonc/);
});
