import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const password = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "native-password.ts")).href
);
const importer = await import(
  pathToFileURL(join(process.cwd(), "scripts", "import-native-password-credentials.mjs")).href
);
const workerImport = await import(
  pathToFileURL(join(process.cwd(), "lib", "cloudflare", "native-password-import.ts")).href
);

const BCRYPT = "$2b$10$widJUK7jKi23MXNNqVykquB9Wm//RM1tzrMBFy/jZMJBIDUX3qrBm";

test("Cloudflare validates and checks an imported Supabase-compatible bcrypt verifier", async () => {
  assert.equal(password.isImportedBcryptVerifier(BCRYPT), true);
  assert.equal(password.isImportedBcryptVerifier("$2b$99$not-a-verifier"), false);
  assert.equal(await password.verifyImportedBcryptPassword("BandUp non-matching bcrypt timing value", BCRYPT), true);
  assert.equal(await password.verifyImportedBcryptPassword("wrong password", BCRYPT), false);
});

test("the private import parser and Worker transaction validate source ownership without exposing a verifier", () => {
  const rows = importer.parsePasswordExport(JSON.stringify({
    id: "11111111-1111-4111-8111-111111111111",
    email: "person@example.com",
    encrypted_password: BCRYPT,
    updated_at: "2026-08-28T00:00:00.000Z",
  }));
  assert.deepEqual(rows.map((row) => ({
    userId: row.userId,
    email: row.email,
    sourceUpdatedAt: row.sourceUpdatedAt,
  })), [{
    userId: "11111111-1111-4111-8111-111111111111",
    email: "person@example.com",
    sourceUpdatedAt: "2026-08-28T00:00:00.000Z",
  }]);
  assert.equal(rows[0].verifier, BCRYPT);
  assert.throws(() => importer.parsePasswordExport(JSON.stringify({
    id: "11111111-1111-4111-8111-111111111111",
    email: "person@example.com",
    encrypted_password: "plaintext",
    updated_at: "2026-08-28T00:00:00.000Z",
  })), /bcrypt verifier/);
});

test("one credential is written through a two-statement atomic D1 batch with bound values", async () => {
  const prepared = [];
  const bindings = {
    db: {
      prepare(query) {
        return {
          bind(...values) {
            const statement = { query, values };
            prepared.push(statement);
            return statement;
          },
        };
      },
      async batch(statements) {
        assert.equal(statements.length, 2);
        return [
          { success: true, meta: { changes: 1 } },
          { success: true, meta: { changes: 1 } },
        ];
      },
    },
  };
  const outcome = await workerImport.importNativePasswordCredential({
    userId: "11111111-1111-4111-8111-111111111111",
    email: "person@example.com",
    verifier: BCRYPT,
    sourceUpdatedAt: "2026-08-28T00:00:00.000Z",
  }, bindings, Date.UTC(2026, 7, 28, 1));
  assert.equal(outcome, "stored");
  assert.equal(prepared.length, 2);
  assert.match(prepared[0].query, /INSERT INTO app_password_credentials/);
  assert.match(prepared[0].query, /FROM app_users/);
  assert.match(prepared[0].query, /lower\(email\) = lower\(\?\)/);
  assert.doesNotMatch(prepared[0].query, new RegExp(BCRYPT.replaceAll("$", "\\$")));
  assert.equal(prepared[0].values[0], BCRYPT);
});

test("native password auth is server-only, gated, and never falls back to Supabase after cutover", () => {
  const route = readFileSync(join(process.cwd(), "app", "api", "auth", "password", "route.ts"), "utf8");
  const native = readFileSync(join(process.cwd(), "lib", "auth", "native-password.ts"), "utf8");
  const nativeImport = readFileSync(join(process.cwd(), "lib", "cloudflare", "native-password-import.ts"), "utf8");
  const routeImport = readFileSync(join(process.cwd(), "app", "api", "admin", "cloudflare", "password-import", "route.ts"), "utf8");
  const migration = readFileSync(join(process.cwd(), "cloudflare", "migrations", "0016_cloudflare_password_credentials.sql"), "utf8");
  assert.match(route, /const nativeActive = nativeAuthCutoverActive\(\)/);
  assert.match(route, /!nativeActive && !supabaseConfigured\(\)/);
  assert.match(route, /signInWithImportedNativePassword/);
  assert.match(route, /if \(nativeActive\) \{[\s\S]*?startNativePasswordRegistration/);
  assert.match(native, /assertServerOnly\(MODULE\)/);
  assert.match(native, /BOGUS_BCRYPT_VERIFIER/);
  assert.match(native, /LEFT JOIN app_password_credentials/);
  assert.match(nativeImport, /await bindings\.db\.batch\(/);
  assert.match(nativeImport, /WHERE id = \?[\s\S]*lower\(email\) = lower\(\?\)/);
  assert.match(routeImport, /body\.confirm !== true/);
  assert.match(routeImport, /isAdminEmail\(actor\.email\)/);
  assert.match(routeImport, /Cache-Control": "private, no-store/);
  assert.match(migration, /REFERENCES app_users\(id\) ON DELETE CASCADE/);
  assert.match(migration, /scheme = 'bcrypt'/);
});
