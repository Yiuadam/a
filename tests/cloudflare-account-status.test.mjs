import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const status = await import(
  pathToFileURL(join(process.cwd(), "lib", "cloudflare", "account-status.ts")).href
);
const identityAudit = await import(
  pathToFileURL(join(process.cwd(), "lib", "cloudflare", "native-identity-audit.ts")).href
);

async function withEnv(values, work) {
  const saved = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await work();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function bindingsFor({ usage = [], grants = [] } = {}) {
  const queries = [];
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async all() {
              queries.push({ sql, values });
              if (sql.includes("MIN(created_at)")) {
                return {
                  success: true,
                  results: [{ oldest_at: usage[0]?.created_at ?? null }],
                  meta: { changes: 0 },
                };
              }
              if (sql.includes("GROUP BY route")) {
                const grouped = new Map();
                for (const item of usage) grouped.set(item.route, (grouped.get(item.route) ?? 0) + 1);
                return {
                  success: true,
                  results: [...grouped].map(([route, used]) => ({ route, used })),
                  meta: { changes: 0 },
                };
              }
              if (sql.includes("FROM subscriptions")) {
                return { success: true, results: grants, meta: { changes: 0 } };
              }
              throw new Error("unexpected query");
            },
          };
        },
      };
    },
    async batch(statements) {
      return await Promise.all(statements.map((statement) => statement.all()));
    },
  };
  return { bindings: { db, files: {} }, queries };
}

test("Cloudflare account status reads the same D1 allowance and subscription facts", async () => {
  const { bindings, queries } = bindingsFor({
    usage: [
      { route: "define", created_at: "2026-08-28T00:00:10.000Z" },
      { route: "define", created_at: "2026-08-28T00:01:10.000Z" },
      { route: "tutor-chat", created_at: "2026-08-28T00:02:10.000Z" },
    ],
    grants: [{
      provider: "stripe",
      tier: "pro",
      external_price_id: "price_pro",
      current_period_end: "2026-09-28T00:00:00.000Z",
      cancel_at_period_end: 0,
    }],
  });
  const userId = "11111111-1111-4111-8111-111111111111";
  const now = Date.UTC(2026, 7, 28, 1, 0, 0);

  assert.deepEqual(
    await status.cloudflareUsageDetail(userId, 3_600, bindings, now),
    {
      oldestAt: "2026-08-28T00:00:10.000Z",
      byRoute: { define: 2, "tutor-chat": 1 },
    },
  );
  assert.deepEqual(await status.currentCloudflareAccessGrants(userId, bindings), [{
    provider: "stripe",
    tier: "pro",
    priceId: "price_pro",
    currentPeriodEnd: "2026-09-28T00:00:00.000Z",
    cancelAtPeriodEnd: false,
  }]);
  assert.equal(queries.every(({ values }) => values.includes(userId)), true);
});

test("identity readiness uses provider subjects and existing stable ids, never email matches", async () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const subject = "google-subject-123";
  const queries = [];
  const bindings = {
    db: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              async all() {
                queries.push({ sql, values });
                if (sql.includes("sqlite_master")) {
                  return {
                    success: true,
                    results: [
                      { name: "app_users" },
                      { name: "app_user_identities" },
                      { name: "app_auth_sessions" },
                    ],
                    meta: { changes: 0 },
                  };
                }
                if (sql.includes("SELECT identity_authority")) {
                  return { success: true, results: [], meta: { changes: 0 } };
                }
                if (sql.includes("FROM app_users")) {
                  return { success: true, results: [{ id: userId }], meta: { changes: 0 } };
                }
                if (sql.includes("FROM app_user_identities")) {
                  return { success: true, results: [], meta: { changes: 0 } };
                }
                throw new Error("unexpected audit query");
              },
            };
          },
          async all() {
            if (sql.includes("sqlite_master")) {
              return {
                success: true,
                results: [
                  { name: "app_users" },
                  { name: "app_user_identities" },
                  { name: "app_auth_sessions" },
                ],
                meta: { changes: 0 },
              };
            }
            if (sql.includes("SELECT identity_authority")) {
              return { success: true, results: [], meta: { changes: 0 } };
            }
            throw new Error("unexpected unbound audit query");
          },
        };
      },
    },
    files: {},
  };
  const report = await identityAudit.nativeIdentityReadinessReport(bindings, {
    readSource: async () => [{
      authUserId: userId,
      identityUserId: userId,
      providerSubject: subject,
      email: "same-email-must-not-link@example.test",
      emailVerified: true,
    }],
    readAccounts: async () => [{ id: userId }],
  });

  assert.equal(report.target.schema, "ready", JSON.stringify(report));
  assert.equal(report.target.sourceUsersPresent, 1, JSON.stringify(report));
  assert.deepEqual(report.mappings, { correct: 0, missing: 1, mismatched: 0 });
  assert.equal(report.readyForBackfill, true);
  assert.equal(report.readyForGoogleCutover, false);
  assert.equal(report.readyForNativeAuthCutover, false);
  assert.equal(JSON.stringify(report).includes(subject), false);
  assert.equal(JSON.stringify(report).includes("same-email-must-not-link@example.test"), false);
  assert.equal(queries.some(({ sql }) => /lower\(email\)/i.test(sql)), false);
});

test("Google ID-token cutover is ready without the optional server-flow secret", async () => {
  const bindings = {
    db: {
      prepare(sql) {
        return {
          bind() {
            return this;
          },
          async all() {
            if (sql.includes("sqlite_master")) {
              return {
                success: true,
                results: [
                  { name: "app_users" },
                  { name: "app_user_identities" },
                  { name: "app_auth_sessions" },
                ],
                meta: { changes: 0 },
              };
            }
            if (sql.includes("SELECT identity_authority")) {
              return { success: true, results: [], meta: { changes: 0 } };
            }
            throw new Error("unexpected query");
          },
        };
      },
    },
    files: {},
  };

  await withEnv({
    ACCOUNTS_ENABLED: "1",
    CLOUDFLARE_NATIVE_AUTH: "1",
    CLOUDFLARE_DATA_MODE: "cloudflare",
    ORGANIZATION_DATA_MODE: "cloudflare",
    GOOGLE_CLIENT_ID: "bandup-web.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET: "",
    GOOGLE_OAUTH_APP_ORIGIN: "https://bandup.example.test",
  }, async () => {
    const report = await identityAudit.nativeIdentityReadinessReport(bindings, {
      readSource: async () => [],
      readAccounts: async () => [],
    });
    assert.equal(report.configured.directGoogleServerFlow, false);
    assert.equal(report.readyForGoogleCutover, true, JSON.stringify(report));
    assert.deepEqual(report.blockers, []);
  });
});

test("native cutover stays blocked when a legacy Apple provider still exists", async () => {
  const bindings = {
    db: {
      prepare(sql) {
        return {
          bind() {
            return this;
          },
          async all() {
            if (sql.includes("sqlite_master")) {
              return {
                success: true,
                results: [
                  { name: "app_users" },
                  { name: "app_user_identities" },
                  { name: "app_auth_sessions" },
                ],
                meta: { changes: 0 },
              };
            }
            if (sql.includes("SELECT identity_authority")) {
              return { success: true, results: [], meta: { changes: 0 } };
            }
            throw new Error("unexpected query");
          },
        };
      },
    },
    files: {},
  };

  await withEnv({
    ACCOUNTS_ENABLED: "1",
    CLOUDFLARE_NATIVE_AUTH: "1",
    CLOUDFLARE_DATA_MODE: "cloudflare",
    ORGANIZATION_DATA_MODE: "cloudflare",
    GOOGLE_CLIENT_ID: "bandup-web.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET: "",
    GOOGLE_OAUTH_APP_ORIGIN: "https://bandup.example.test",
  }, async () => {
    const report = await identityAudit.nativeIdentityReadinessReport(bindings, {
      readSource: async () => [],
      readAccounts: async () => [],
      readProviderSummary: async () => ({
        google: 0,
        apple: 1,
        email: 0,
        unsupported: 0,
        invalid: 0,
      }),
    });
    assert.equal(report.readyForGoogleCutover, true, JSON.stringify(report));
    assert.equal(report.readyForNativeAuthCutover, false, JSON.stringify(report));
    assert.equal(report.source.appleIdentities, 1);
    assert.match(report.blockers.join("\n"), /Apple identity record/);
  });
});

test("native cutover refuses a current Supabase account that is absent from D1", async () => {
  const userId = "22222222-2222-4222-8222-222222222222";
  const bindings = {
    db: {
      prepare(sql) {
        return {
          bind() {
            return this;
          },
          async all() {
            if (sql.includes("sqlite_master")) {
              return {
                success: true,
                results: [
                  { name: "app_users" },
                  { name: "app_user_identities" },
                  { name: "app_auth_sessions" },
                ],
                meta: { changes: 0 },
              };
            }
            if (sql.includes("SELECT identity_authority")) {
              return { success: true, results: [], meta: { changes: 0 } };
            }
            if (sql.includes("FROM app_users")) {
              return { success: true, results: [], meta: { changes: 0 } };
            }
            throw new Error("unexpected query");
          },
        };
      },
    },
    files: {},
  };

  await withEnv({
    ACCOUNTS_ENABLED: "1",
    CLOUDFLARE_NATIVE_AUTH: "1",
    CLOUDFLARE_DATA_MODE: "cloudflare",
    ORGANIZATION_DATA_MODE: "cloudflare",
    GOOGLE_CLIENT_ID: "bandup-web.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET: "",
    GOOGLE_OAUTH_APP_ORIGIN: "https://bandup.example.test",
  }, async () => {
    const report = await identityAudit.nativeIdentityReadinessReport(bindings, {
      readSource: async () => [],
      readAccounts: async () => [{ id: userId }],
    });
    assert.deepEqual(report.accounts, {
      status: "available",
      supabaseAuthUsers: 1,
      invalidUsers: 0,
      duplicateUserIds: 0,
      liveD1UsersPresent: 0,
      liveD1UsersMissing: 1,
    });
    assert.equal(report.readyForGoogleCutover, false);
    assert.match(report.blockers.join("\n"), /missing a live D1 app_users record/);
  });
});
