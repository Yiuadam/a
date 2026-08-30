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
const nativeIdentity = await import(
  pathToFileURL(join(process.cwd(), "lib", "cloudflare", "native-identity.ts")).href
);

const BCRYPT = "$2b$10$widJUK7jKi23MXNNqVykquB9Wm//RM1tzrMBFy/jZMJBIDUX3qrBm";

function passwordBindings(row, batchResults = [{ success: true }, { success: true }]) {
  const prepared = [];
  return {
    prepared,
    bindings: {
      db: {
        prepare(query) {
          return {
            bind(...values) {
              const statement = {
                query,
                values,
                first: async () => /\bSELECT\b/.test(query) ? row : null,
                run: async () => ({ success: true }),
              };
              prepared.push(statement);
              return statement;
            },
          };
        },
        async batch(statements) {
          assert.equal(statements.length, 2);
          return batchResults;
        },
      },
    },
  };
}

test("Cloudflare validates and checks an imported Supabase-compatible bcrypt verifier", async () => {
  assert.equal(password.isImportedBcryptVerifier(BCRYPT), true);
  assert.equal(password.isImportedBcryptVerifier("$2b$99$not-a-verifier"), false);
  assert.equal(await password.verifyImportedBcryptPassword("BandUp non-matching bcrypt timing value", BCRYPT), true);
  assert.equal(await password.verifyImportedBcryptPassword("wrong password", BCRYPT), false);
  assert.equal(await password.verifyImportedBcryptPassword("", BCRYPT), false);
  assert.equal(await password.verifyImportedBcryptPassword("a".repeat(201), BCRYPT), false);
  assert.equal(await password.verifyImportedBcryptPassword("password", "not-a-bcrypt-verifier"), false);
});

test("native password sign-in performs the bounded D1 path and fails closed", async () => {
  const row = {
    id: "11111111-1111-4111-8111-111111111111",
    email: "person@example.com",
    created_at: "2026-08-28T00:00:00.000Z",
    deleted_at: null,
    verifier: BCRYPT,
    scheme: "bcrypt",
    status: "active",
  };
  const now = Date.UTC(2026, 7, 28, 1);
  const active = passwordBindings(row);
  const session = await password.signInWithImportedNativePassword(
    row.email,
    "BandUp non-matching bcrypt timing value",
    "a dedicated test session signing secret",
    active.bindings,
    now,
  );
  assert.ok(session?.accessToken);
  assert.ok(session?.refreshToken);
  assert.equal(session?.email, row.email);
  assert.equal(active.prepared.filter((statement) => statement.query.includes("app_auth_sessions")).length, 1);

  const wrongPassword = passwordBindings(row);
  assert.equal(await password.signInWithImportedNativePassword(
    row.email,
    "wrong password",
    "a dedicated test session signing secret",
    wrongPassword.bindings,
    now,
  ), null);
  assert.equal(wrongPassword.prepared.filter((statement) => statement.query.includes("app_auth_sessions")).length, 0);

  for (const invalidRow of [
    null,
    { ...row, deleted_at: "2026-08-28T00:00:00.000Z" },
    { ...row, scheme: "legacy" },
    { ...row, status: "disabled" },
    { ...row, verifier: "not-a-bcrypt-verifier" },
  ]) {
    const rejected = passwordBindings(invalidRow);
    assert.equal(await password.signInWithImportedNativePassword(
      row.email,
      "BandUp non-matching bcrypt timing value",
      "a dedicated test session signing secret",
      rejected.bindings,
      now,
    ), null);
  }

  for (const [email, secret] of [["", "secret"], ["a".repeat(255), "secret"], [row.email, ""]]) {
    assert.equal(await password.signInWithImportedNativePassword(email, "password", secret, undefined, now), null);
  }

  const failedWrite = passwordBindings(row, [{ success: false }, { success: true }]);
  await assert.rejects(
    password.signInWithImportedNativePassword(
      row.email,
      "BandUp non-matching bcrypt timing value",
      "a dedicated test session signing secret",
      failedWrite.bindings,
      now,
    ),
    /credential could not be recorded/,
  );
});

test("a verified legacy identity is bridged only to its existing live D1 user", async () => {
  const row = {
    id: "11111111-1111-4111-8111-111111111111",
    email: "person@example.com",
    created_at: "2026-08-28T00:00:00.000Z",
    deleted_at: null,
  };
  const now = Date.UTC(2026, 7, 28, 1);
  const live = passwordBindings(row);
  const upgraded = await nativeIdentity.bridgeLegacyBrowserSession(
    { id: row.id, email: "legacy-email-ignored@example.com", createdAt: row.created_at },
    "a dedicated test session signing secret",
    live.bindings,
    now,
  );
  assert.ok(upgraded?.accessToken);
  assert.ok(upgraded?.refreshToken);
  assert.equal(upgraded?.email, row.email, "the bridge uses D1's identity record");
  assert.equal(live.prepared.filter((statement) => statement.query.includes("app_auth_sessions")).length, 1);

  for (const invalidRow of [null, { ...row, deleted_at: "2026-08-28T00:00:00.000Z" }]) {
    const rejected = passwordBindings(invalidRow);
    assert.equal(await nativeIdentity.bridgeLegacyBrowserSession(
      { id: row.id, email: row.email, createdAt: row.created_at },
      "a dedicated test session signing secret",
      rejected.bindings,
      now,
    ), null);
    assert.equal(rejected.prepared.filter((statement) => statement.query.includes("app_auth_sessions")).length, 0);
  }
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

test("a complete source batch prechecks every stable D1 identity before one atomic write", async () => {
  const prepared = [];
  let batches = 0;
  const first = {
    userId: "11111111-1111-4111-8111-111111111111",
    email: "first@example.com",
    verifier: BCRYPT,
    sourceUpdatedAt: "2026-08-28T00:00:00.000Z",
  };
  const second = {
    userId: "22222222-2222-4222-8222-222222222222",
    email: "second@example.com",
    verifier: "$2b$10$O3qtiPNUNg1dIX2p3iY2Z.45nGd9IL8UnLiW2C/RUxNh5JysNcpE.",
    sourceUpdatedAt: "2026-08-28T00:01:00.000Z",
  };
  const bindings = {
    db: {
      prepare(query) {
        return {
          bind(...values) {
            const statement = {
              query,
              values,
              all: async () => query.includes("SELECT id, email FROM app_users")
                ? { success: true, results: [{ id: first.userId, email: first.email }, { id: second.userId, email: second.email }] }
                : { success: true, results: [] },
            };
            prepared.push(statement);
            return statement;
          },
        };
      },
      async batch(statements) {
        batches += 1;
        assert.equal(statements.length, 6);
        return statements.map(() => ({ success: true, meta: { changes: 1 } }));
      },
    },
  };
  const result = await workerImport.importNativePasswordCredentialBatch([first, second], bindings, Date.UTC(2026, 7, 28, 1));
  assert.deepEqual(result, { status: "stored", stored: 2 });
  assert.equal(batches, 1);
  assert.match(prepared[0].query, /SELECT id, email FROM app_users/);
  assert.equal(prepared.filter((statement) => /exact_import/.test(statement.query)).length, 2);
  assert.match(prepared.at(-1).query, /abs\(-9223372036854775808\)/);
});

test("a stale concurrent credential causes the entire import batch to fail rather than certify a partial write", async () => {
  const credential = {
    userId: "11111111-1111-4111-8111-111111111111",
    email: "person@example.com",
    verifier: BCRYPT,
    sourceUpdatedAt: "2026-08-28T00:00:00.000Z",
  };
  const bindings = {
    db: {
      prepare(query) {
        return {
          bind(...values) {
            return {
              query,
              values,
              all: async () => ({ success: true, results: [{ id: credential.userId, email: credential.email }] }),
            };
          },
        };
      },
      async batch(statements) {
        assert.equal(statements.length, 3);
        // D1 runs this batch as one transaction. The guard statement raises a
        // SQLite error, so the two preceding writes are rolled back with it.
        throw new Error("integer overflow: SQLITE_ERROR");
      },
    },
  };
  await assert.rejects(
    workerImport.importNativePasswordCredentialBatch([credential], bindings),
    /native password credential batch could not be imported|integer overflow/,
  );
});

test("a source batch with one unmatched D1 account performs no password writes", async () => {
  let batches = 0;
  const bindings = {
    db: {
      prepare() {
        return {
          bind() {
            return { all: async () => ({ success: true, results: [] }) };
          },
        };
      },
      async batch() {
        batches += 1;
        return [];
      },
    },
  };
  const result = await workerImport.importNativePasswordCredentialBatch([{
    userId: "11111111-1111-4111-8111-111111111111",
    email: "person@example.com",
    verifier: BCRYPT,
    sourceUpdatedAt: "2026-08-28T00:00:00.000Z",
  }], bindings);
  assert.deepEqual(result, { status: "mismatch", stored: 0 });
  assert.equal(batches, 0);
});

test("native password auth is server-only, gated, and never falls back to Supabase after cutover", () => {
  const route = readFileSync(join(process.cwd(), "app", "api", "auth", "password", "route.ts"), "utf8");
  const native = readFileSync(join(process.cwd(), "lib", "auth", "native-password.ts"), "utf8");
  const nativeImport = readFileSync(join(process.cwd(), "lib", "cloudflare", "native-password-import.ts"), "utf8");
  const routeImport = readFileSync(join(process.cwd(), "app", "api", "admin", "cloudflare", "password-import", "route.ts"), "utf8");
  const migration = readFileSync(join(process.cwd(), "cloudflare", "migrations", "0016_cloudflare_password_credentials.sql"), "utf8");
  const upgrade = readFileSync(join(process.cwd(), "app", "api", "auth", "native", "upgrade", "route.ts"), "utf8");
  const browserUpgrade = readFileSync(join(process.cwd(), "components", "account", "NativeSessionUpgrade.tsx"), "utf8");
  const refresh = readFileSync(join(process.cwd(), "app", "api", "auth", "refresh", "route.ts"), "utf8");
  assert.match(route, /const nativeActive = nativeAuthCutoverActive\(\)/);
  assert.match(route, /!nativeActive && !supabaseConfigured\(\)/);
  assert.match(route, /signInWithImportedNativePassword/);
  assert.match(route, /if \(nativeActive\) \{[\s\S]*?startNativePasswordRegistration/);
  assert.match(native, /assertServerOnly\(MODULE\)/);
  assert.match(native, /BOGUS_BCRYPT_VERIFIER/);
  assert.match(native, /LEFT JOIN app_password_credentials/);
  assert.match(nativeImport, /await bindings\.db\.batch\(/);
  assert.match(nativeImport, /WHERE id = \?[\s\S]*lower\(email\) = lower\(\?\)/);
  assert.match(nativeImport, /migration_source = excluded\.migration_source/);
  assert.match(nativeImport, /'supabase_import'/);
  assert.match(routeImport, /body\.confirm !== true/);
  assert.match(routeImport, /isAdminEmail\(actor\.email\)/);
  assert.match(routeImport, /Cache-Control": "private, no-store/);
  assert.match(migration, /REFERENCES app_users\(id\) ON DELETE CASCADE/);
  assert.match(migration, /scheme = 'bcrypt'/);
  assert.match(upgrade, /nativeAuthCutoverActive\(\)/);
  assert.match(upgrade, /userFromAccessToken/);
  assert.match(upgrade, /bridgeLegacyBrowserSession/);
  assert.match(upgrade, /looksLikeNativeAccessToken/);
  assert.match(upgrade, /Cache-Control": "private, no-store/);
  assert.match(browserUpgrade, /upgradeLegacySession/);
  assert.match(browserUpgrade, /getSnapshot\(\)\?\.accessToken === session\.accessToken/);
  assert.match(refresh, /refreshNativeBrowserSession\(token, signingKey\)/);
  assert.match(refresh, /if \(session\) return NextResponse\.json\(session\)/);
  assert.match(refresh, /if \(!supabaseConfigured\(\)\)/);
  assert.match(refresh, /const legacySession = await refreshAccessToken\(token\)/);
  assert.match(refresh, /auth\/refresh\/legacy-bridge/);
});
