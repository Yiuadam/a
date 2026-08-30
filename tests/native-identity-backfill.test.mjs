import assert from "node:assert/strict";
import { register } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const backfill = await import(
  pathToFileURL(join(process.cwd(), "lib", "cloudflare", "native-identity-backfill.ts")).href
);

function target({ users, mappings = [] }) {
  const liveUsers = new Set(users);
  const bySubject = new Map(mappings.map((row) => [row.subject, row.userId]));
  const byUser = new Map(mappings.map((row) => [row.userId, row.subject]));
  const queries = [];
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            sql,
            values,
            async all() {
              queries.push({ sql, values });
              if (sql.includes("SELECT id FROM app_users")) {
                return { success: true, results: values.filter((id) => liveUsers.has(id)).map((id) => ({ id })), meta: { changes: 0 } };
              }
              if (sql.includes("provider_subject IN")) {
                return { success: true, results: values.flatMap((subject) => bySubject.has(subject) ? [{ provider_subject: subject, user_id: bySubject.get(subject) }] : []), meta: { changes: 0 } };
              }
              if (sql.includes("user_id IN")) {
                return { success: true, results: values.flatMap((userId) => byUser.has(userId) ? [{ provider_subject: byUser.get(userId), user_id: userId }] : []), meta: { changes: 0 } };
              }
              throw new Error("unexpected D1 query");
            },
          };
        },
      };
    },
    async batch(statements) {
      for (const statement of statements) {
        assert.match(statement.sql, /INSERT INTO app_user_identities/);
        const [subject, userId] = statement.values;
        if (bySubject.has(subject) && bySubject.get(subject) !== userId) {
          return [{ success: false, meta: { changes: 0 } }];
        }
        if (byUser.has(userId) && byUser.get(userId) !== subject) {
          return [{ success: false, meta: { changes: 0 } }];
        }
        bySubject.set(subject, userId);
        byUser.set(userId, subject);
      }
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
  return { bindings: { db, files: {} }, bySubject, queries };
}

test("Google identity backfill copies provider subjects to their existing D1 ids only", async () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const { bindings, bySubject, queries } = target({ users: [userId] });
  const result = await backfill.backfillNativeGoogleIdentities(bindings, {
    now: Date.UTC(2026, 7, 28, 0, 0, 0),
    readSource: async () => [{
      authUserId: userId,
      identityUserId: userId,
      providerSubject: "google-immutable-subject-123",
      email: "mutable-email@example.test",
      emailVerified: true,
    }],
  });
  assert.deepEqual(result, { sourceGoogleIdentities: 1, mappingsCreated: 1, mappingsAlreadyCorrect: 0 });
  assert.equal(bySubject.get("google-immutable-subject-123"), userId);
  assert.equal(JSON.stringify(result).includes("google-immutable-subject-123"), false);
  assert.equal(JSON.stringify(result).includes("mutable-email@example.test"), false);
  assert.equal(queries.some(({ sql }) => /lower\(email\)|email\s*=/i.test(sql)), false);
});

test("identity backfill fails before writing a duplicate or unproven source identity", async () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const { bindings, bySubject } = target({ users: [userId] });
  await assert.rejects(
    backfill.backfillNativeGoogleIdentities(bindings, {
      readSource: async () => [{
        authUserId: userId,
        identityUserId: userId,
        providerSubject: "same-subject",
        email: "one@example.test",
        emailVerified: true,
      }, {
        authUserId: userId,
        identityUserId: userId,
        providerSubject: "same-subject",
        email: "two@example.test",
        emailVerified: true,
      }],
    }),
    /duplicate provider subjects/,
  );
  assert.equal(bySubject.size, 0);
});
