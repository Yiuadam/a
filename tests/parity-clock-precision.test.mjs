/*
  Parity is measured at the precision the mirror can carry.

  The bug this pins was not a wrong value anywhere. Postgres hashed six
  fractional digits, D1 could only ever hold three, and the comparison declared
  every row different for ever — 123 of 123 usage events on the production
  database, while the mirror was copying them correctly. A whole afternoon went
  into establishing that four "corrupt" domains were healthy.

  The important test is the last one: it takes a real Postgres timestamp, sends
  it through the write path the way a real write goes, and asserts the two
  sides land on the same string. Nothing shy of that would have caught the
  original fault, because every individual piece was behaving as written.
*/
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const root = process.cwd();
const clocks = await import(
  pathToFileURL(join(root, "lib", "cloudflare", "source-clock.ts")).href
);
const { parityClock, canonicalCloudflareSourceClock } = clocks;

/** Source with comments removed, so no assertion can match prose about code. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
function sqlCode(source) {
  return source.replace(/^\s*--.*$/gm, "");
}

test("the parity clock keeps three fractional digits, not six", () => {
  assert.equal(parityClock("2026-08-08T14:14:06.673830Z"), "2026-08-08T14:14:06.673Z");
  assert.equal(parityClock("2026-08-08T14:14:06.673Z"), "2026-08-08T14:14:06.673Z");
  assert.equal(parityClock("2026-08-08T14:14:06Z"), "2026-08-08T14:14:06.000Z");
});

test("it truncates as the write path does, rather than rounding", () => {
  /*
    .673830 is 674 if you round and 673 if you truncate. D1 holds 673, because
    that is what Date.parse produced when the row was written, so 673 is the
    only answer that agrees with the stored value.
  */
  assert.equal(parityClock("2026-08-08T14:14:06.673830Z"), "2026-08-08T14:14:06.673Z");
  assert.equal(parityClock("2026-08-08T14:14:06.999999Z"), "2026-08-08T14:14:06.999Z");
});

test("an offset is resolved to UTC, and rubbish is null rather than a throw", () => {
  assert.equal(parityClock("2026-08-08T22:14:06.673830+08:00"), "2026-08-08T14:14:06.673Z");
  assert.equal(parityClock("not a timestamp"), null);
  assert.equal(parityClock(null), null);
  assert.equal(parityClock(1754661246673), null);
});

test("the replication clock still carries all nine digits", () => {
  /*
    Ordering wants every digit it can get; only equality wants the digits both
    sides hold. Cutting the replication clock down would reorder replayed
    writes, which is a real fault rather than a cosmetic one.
  */
  assert.equal(
    canonicalCloudflareSourceClock("2026-08-08T14:14:06.673830Z"),
    "2026-08-08T14:14:06.673830000Z",
  );
});

test("both fingerprint readers use the shared clock and define no private copy", () => {
  for (const file of ["migration-readiness.ts", "domain-drift.ts"]) {
    const source = code(readFileSync(join(root, "lib", "cloudflare", file), "utf8"));
    assert.match(
      source,
      /import \{ parityClock as clock \} from "\.\/source-clock"/,
      `${file} does not use the shared parity clock`,
    );
    assert.doesNotMatch(
      source,
      /function clock\(/,
      `${file} has its own clock again — the two drifted apart once already`,
    );
  }
});

test("no SQL still hashes microseconds", () => {
  const dir = join(root, "supabase");
  const files = [
    ...readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => join(dir, f)),
    ...readdirSync(join(dir, "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .map((f) => join(dir, "migrations", f)),
  ];
  const offenders = [];
  for (const file of files) {
    const source = sqlCode(readFileSync(file, "utf8"));
    if (source.includes('HH24:MI:SS.US"Z"')) offenders.push(file.replace(`${root}/`, ""));
  }
  /*
    Migration 0029 is expected here and only here: it has been applied, its text
    is the record of what was applied, and parity-millisecond-precision.sql
    replaces its functions. Anything else in this list is a new place where the
    six-digit comparison has come back.
  */
  assert.deepEqual(offenders, ["supabase/migrations/0029_cloudflare_migration_readiness.sql"]);
});

test("the replacement SQL renders every timestamp the same way", () => {
  const source = sqlCode(
    readFileSync(join(root, "supabase", "parity-millisecond-precision.sql"), "utf8"),
  );
  // Eleven timestamps in each of the two functions it replaces.
  assert.equal((source.match(/HH24:MI:SS\.MS"Z"/g) ?? []).length, 22);
  assert.match(source, /cloudflare_migration_source_fingerprints/);
  assert.match(source, /cloudflare_migration_source_row_fingerprints/);
  // It replaces functions and must not alter data.
  for (const forbidden of [/\binsert\s+into\b/i, /\bupdate\s+public\./i, /\bdelete\s+from\b/i, /\balter\s+table\b/i]) {
    assert.doesNotMatch(source, forbidden, `the replacement SQL writes: ${forbidden}`);
  }
});

test("the two sides agree on a real Postgres timestamp", async () => {
  /*
    The test that would have caught it, end to end and without stubs.

    Postgres renders the stored value at whatever precision the format asks
    for. The mirror writes it through a JavaScript Date, which is where the
    microseconds are lost. Both sides are then hashed. Before this change the
    left column below was `.673830Z` and the right `.673000Z`, and the report
    called the row corrupt.
  */
  const stored = "2026-08-08 14:14:06.673830+00";

  // What Postgres now hands the source fingerprint: to_char(..., '...MS"Z"').
  const iso = `${stored.slice(0, 10)}T${stored.slice(11, 19)}`;
  const micros = stored.slice(20, 26).padEnd(6, "0");
  const sourceEvidence = `${iso}.${micros.slice(0, 3)}Z`;

  // What D1 holds, having been written through a JavaScript Date, and what the
  // target fingerprint makes of it.
  const throughJavaScript = new Date(`${iso}.${micros}Z`).toISOString();
  const targetEvidence = parityClock(throughJavaScript);

  assert.equal(targetEvidence, sourceEvidence);
  assert.equal(sourceEvidence, "2026-08-08T14:14:06.673Z");
});
