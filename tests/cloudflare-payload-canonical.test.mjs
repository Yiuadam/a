import assert from "node:assert/strict";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);
const canonical = await load("lib", "cloudflare", "payload-canonical.ts");

test("key order never changes the canonical form or its hash", async () => {
  const a = { b: 1.5, a: [1, 2, "x\ny", null, true, false], c: { z: 1, y: 2 } };
  const b = { a: [1, 2, "x\ny", null, true, false], c: { y: 2, z: 1 }, b: 1.5 };
  const expected = '{"a":[1,2,"x\\ny",null,true,false],"b":1.5,"c":{"y":2,"z":1}}';
  assert.equal(canonical.canonicalizePayloadJson(a), expected);
  assert.equal(canonical.canonicalizePayloadJson(b), expected);
  assert.equal(await canonical.canonicalPayloadHash(a), await canonical.canonicalPayloadHash(b));
});

test("a number is written the same minimal way PostgreSQL numeric would print it", () => {
  const cases = [
    [1.5, "1.5"], [100, "100"], [0, "0"], [-0, "0"], [-5, "-5"], [-0.5, "-0.5"],
    [0.05, "0.05"], [1.10, "1.1"], [1e21, "1000000000000000000000"],
    [0.0000001, "0.0000001"], [1.5e-7, "0.00000015"],
    [123456789012345680000, "123456789012345680000"],
    [0.1 + 0.2, "0.30000000000000004"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(canonical.canonicalPayloadNumber(input), expected, `canonicalPayloadNumber(${input})`);
  }
});

test("a string is escaped exactly the way JSON.stringify escapes a bare string", () => {
  assert.equal(canonical.canonicalizePayloadJson("hi\nthere"), JSON.stringify("hi\nthere"));
  assert.equal(canonical.canonicalizePayloadJson("key\"with\\backslash"), JSON.stringify("key\"with\\backslash"));
  assert.equal(canonical.canonicalizePayloadJson("unicode: é中文😀"), JSON.stringify("unicode: é中文😀"));
  assert.equal(canonical.canonicalizePayloadJson("slash/forward"), JSON.stringify("slash/forward"));
});

test("an absent key is omitted; an explicit null is written as null", () => {
  assert.equal(canonical.canonicalizePayloadJson({ a: 1 }), '{"a":1}');
  assert.equal(canonical.canonicalizePayloadJson({ a: 1, b: null }), '{"a":1,"b":null}');
  assert.equal(canonical.canonicalizePayloadJson({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(canonical.canonicalizePayloadJson(undefined), "null");
  assert.equal(canonical.canonicalizePayloadJson(null), "null");
});

test("array element order is preserved, unlike object keys", () => {
  assert.equal(canonical.canonicalizePayloadJson([3, 1, 2]), "[3,1,2]");
  assert.notEqual(canonical.canonicalizePayloadJson([3, 1, 2]), canonical.canonicalizePayloadJson([1, 2, 3]));
});

test("non-finite numbers refuse to hash rather than silently produce a wrong canonical form", () => {
  assert.throws(() => canonical.canonicalPayloadNumber(Number.NaN));
  assert.throws(() => canonical.canonicalPayloadNumber(Number.POSITIVE_INFINITY));
  assert.throws(() => canonical.canonicalizePayloadJson({ a: Number.NaN }));
});

test("the same logical document canonicalises identically in JavaScript and PostgreSQL", async (t) => {
  /*
    This is the test the task called for: feed the same logical document
    through both paths and assert identical hashes. It talks to a real,
    local PostgreSQL instance and applies supabase/parity-payload-canonical.sql
    (plus the money-field helper it depends on) to a scratch database created
    and dropped for this run only — never Supabase, never any configured
    connection string. It skips cleanly wherever `psql` or a local server is
    not available (this is expected in CI), rather than failing the suite.

    Every fixture below was independently confirmed against a live
    PostgreSQL 16 instance while this file was written; this test exists so
    that confirmation is re-checked on any future change instead of trusted
    from a comment.
  */
  const psql = (sql, database = "postgres") => spawnSync(
    "psql",
    ["-v", "ON_ERROR_STOP=1", "-tA", "-d", database, "-c", sql],
    { encoding: "utf8", env: { ...process.env, PGUSER: process.env.PGUSER ?? "postgres" } },
  );

  const probe = psql("select 1;");
  if (probe.status !== 0) {
    t.skip(`no local PostgreSQL reachable as the postgres role (${probe.stderr?.trim().slice(0, 200) || "psql failed"})`);
    return;
  }

  const dbName = `bandup_payload_canonical_check_${process.pid}`;
  psql(`drop database if exists ${dbName};`);
  const createDb = psql(`create database ${dbName};`);
  if (createDb.status !== 0) {
    t.skip(`could not create a scratch database (${createDb.stderr?.trim().slice(0, 200)})`);
    return;
  }

  try {
    const setup = spawnSync("psql", ["-v", "ON_ERROR_STOP=1", "-d", dbName], {
      encoding: "utf8",
      env: { ...process.env, PGUSER: process.env.PGUSER ?? "postgres" },
      input: `
        create extension if not exists pgcrypto;
        create schema if not exists extensions;
        create or replace function extensions.digest(text, text) returns bytea
          language sql immutable as $wrap$ select public.digest($1, $2); $wrap$;
      `,
    });
    assert.equal(setup.status, 0, setup.stderr);

    const runFile = (path) => spawnSync("psql", ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", join(process.cwd(), path)], {
      encoding: "utf8",
      env: { ...process.env, PGUSER: process.env.PGUSER ?? "postgres" },
    });
    // parity-canonical-evidence.sql also references roles and tables this
    // scratch database was never given (it is written for a full Supabase
    // project), so it exits non-zero here — that is expected. What matters
    // is that its money-field helper, which has no table dependency, made
    // it through before those later statements failed.
    runFile("supabase/parity-canonical-evidence.sql");
    const moneyField = psql("select public.cloudflare_migration_money_field(1.50);", dbName);
    assert.equal(moneyField.status, 0, `cloudflare_migration_money_field must exist: ${moneyField.stderr}`);

    const canonicalFile = runFile("supabase/parity-payload-canonical.sql");
    assert.equal(canonicalFile.status, 0, canonicalFile.stderr);

    const fixtures = [
      { b: 1.5, a: [1, 2, "x\ny", null, true, false], c: { z: 1, y: 2 } },
      null,
      {},
      [],
      1e21,
      0.0000001,
      -0.5,
      "unicode: é中文😀",
      { nested: { a: { b: { c: [1, [2, [3]]] } } } },
      [1, "two", 3.0, null, true, { x: 1 }],
    ];

    for (const fixture of fixtures) {
      const jsHash = await canonical.canonicalPayloadHash(fixture);
      const jsonText = JSON.stringify(fixture ?? null).replace(/'/g, "''");
      const pgResult = psql(
        `select public.cloudflare_migration_payload_hash('${jsonText}'::jsonb);`,
        dbName,
      );
      assert.equal(pgResult.status, 0, pgResult.stderr);
      assert.equal(pgResult.stdout.trim(), jsHash, `hash mismatch for ${jsonText}`);
    }
  } finally {
    spawnSync("psql", ["-v", "ON_ERROR_STOP=1", "-d", "postgres", "-c", `drop database if exists ${dbName};`], {
      encoding: "utf8",
      env: { ...process.env, PGUSER: process.env.PGUSER ?? "postgres" },
    });
  }
});
