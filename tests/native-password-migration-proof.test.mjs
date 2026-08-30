import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { join } from "node:path";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
register("../scripts/ts-resolve.mjs", import.meta.url);

const proof = await import(
  pathToFileURL(join(process.cwd(), "lib", "cloudflare", "native-password-proof.ts")).href
);
const audit = await import(
  pathToFileURL(join(process.cwd(), "lib", "cloudflare", "native-password-migration-audit.ts")).href
);

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";
const FIRST_VERIFIER = "$2b$10$widJUK7jKi23MXNNqVykquB9Wm//RM1tzrMBFy/jZMJBIDUX3qrBm";
const SECOND_VERIFIER = "$2b$10$O3qtiPNUNg1dIX2p3iY2Z.45nGd9IL8UnLiW2C/RUxNh5JysNcpE.";

const ROWS = [
  { userId: FIRST_ID, sourceUpdatedAt: "2026-08-28T00:00:00.000Z", verifier: FIRST_VERIFIER },
  { userId: SECOND_ID, sourceUpdatedAt: "2026-08-28T00:01:00.000Z", verifier: SECOND_VERIFIER },
];

function bindingsFor({ storedProof = null, rows = ROWS, onRun = () => {} } = {}) {
  return {
    db: {
      prepare(sql) {
        if (sql.includes("sqlite_master")) {
          return { first: async () => ({ name: "native_password_migration_proofs" }) };
        }
        if (sql.includes("FROM native_password_migration_proofs")) {
          return { first: async () => storedProof };
        }
        if (sql.includes("FROM app_password_credentials")) {
          return {
            bind() {
              return {
                all: async () => ({
                  success: true,
                  results: rows.map((row) => ({
                    user_id: row.userId,
                    source_updated_at: row.sourceUpdatedAt,
                    verifier: row.verifier,
                  })),
                  meta: { changes: 0 },
                }),
              };
            },
          };
        }
        if (sql.includes("INSERT INTO native_password_migration_proofs")) {
          return {
            bind(...values) {
              return {
                run: async () => {
                  onRun(values);
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }
        throw new Error(`unexpected D1 statement: ${sql}`);
      },
    },
    files: {},
  };
}

test("password migration commitments are canonical and react to one verifier change", async () => {
  const first = await proof.passwordProofManifest(ROWS);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(await proof.passwordProofManifest([...ROWS].reverse()), first);
  assert.notEqual(await proof.passwordProofManifest([
    ROWS[0],
    { ...ROWS[1], verifier: `$2b$10$${"a".repeat(53)}` },
  ]), first);
  assert.equal(await proof.passwordProofManifest([{ ...ROWS[0] }, { ...ROWS[0] }]), null);
});

test("a matching stored certificate proves all imported bcrypt rows without exposing them", async () => {
  const manifest = await proof.passwordProofManifest(ROWS);
  const evidence = await audit.nativePasswordMigrationEvidence(bindingsFor({
    storedProof: {
      source_rows: ROWS.length,
      source_manifest_sha256: manifest,
      target_rows: ROWS.length,
      target_manifest_sha256: manifest,
      verified_at: "2026-08-28T02:00:00.000Z",
    },
  }));
  assert.deepEqual(evidence, {
    status: "verified",
    sourceRows: 2,
    importedRows: 2,
    verifiedAt: "2026-08-28T02:00:00.000Z",
  });
  assert.equal(JSON.stringify(evidence).includes(FIRST_VERIFIER), false);
  assert.equal(JSON.stringify(evidence).includes(FIRST_ID), false);
});

test("a source commitment mismatch writes no certificate and keeps native password cutover blocked", async () => {
  let writes = 0;
  const evidence = await audit.certifyNativePasswordMigration(
    ROWS.length,
    "f".repeat(64),
    bindingsFor({ onRun: () => { writes += 1; } }),
    Date.UTC(2026, 7, 28, 2),
  );
  assert.deepEqual(evidence, {
    status: "mismatch",
    sourceRows: 2,
    importedRows: 2,
    verifiedAt: null,
  });
  assert.equal(writes, 0);
});
