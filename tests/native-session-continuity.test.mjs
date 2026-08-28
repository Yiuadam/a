import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { join } from "node:path";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
register("../scripts/ts-resolve.mjs", import.meta.url);

const identity = await import(
  pathToFileURL(join(process.cwd(), "lib", "cloudflare", "native-identity.ts")).href
);

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "learner@example.test",
  created_at: "2026-08-28T00:00:00.000Z",
  deleted_at: null,
};

function sessionBindings() {
  const sessions = new Map();
  const bindings = {
    db: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              async first() {
                if (sql.includes("FROM app_users") && !sql.includes("app_auth_sessions")) {
                  return values[0] === USER.id ? USER : null;
                }
                if (sql.includes("WHERE s.id = ?")) {
                  const [sessionId, userId, now] = values;
                  const current = sessions.get(sessionId);
                  return current
                    && current.user_id === userId
                    && current.revoked_at === null
                    && current.expires_at > now
                    ? USER
                    : null;
                }
                if (sql.includes("WHERE s.refresh_token_sha256 = ?")) {
                  const [hash, now] = values;
                  const current = [...sessions.values()].find((row) =>
                    row.refresh_token_sha256 === hash && row.revoked_at === null && row.expires_at > now,
                  );
                  return current ? { session_id: current.id, ...USER } : null;
                }
                throw new Error("unexpected session select");
              },
              async run() {
                if (sql.includes("INSERT INTO app_auth_sessions")) {
                  const [id, userId, refreshHash, createdAt, lastSeenAt, expiresAt] = values;
                  sessions.set(id, {
                    id,
                    user_id: userId,
                    refresh_token_sha256: refreshHash,
                    created_at: createdAt,
                    last_seen_at: lastSeenAt,
                    expires_at: expiresAt,
                    revoked_at: null,
                  });
                  return { success: true, meta: { changes: 1 } };
                }
                if (sql.includes("SET refresh_token_sha256 = ?")) {
                  const [nextHash, lastSeenAt, id, oldHash] = values;
                  const current = sessions.get(id);
                  if (!current || current.refresh_token_sha256 !== oldHash || current.revoked_at !== null) {
                    return { success: true, meta: { changes: 0 } };
                  }
                  current.refresh_token_sha256 = nextHash;
                  current.last_seen_at = lastSeenAt;
                  return { success: true, meta: { changes: 1 } };
                }
                throw new Error("unexpected session write");
              },
            };
          },
        };
      },
    },
    files: {},
  };
  return { bindings, sessions };
}

test("an existing verified user keeps a continuous native session across bridge and refresh rotation", async () => {
  const { bindings, sessions } = sessionBindings();
  const signingKey = "a dedicated test session signing secret";
  const now = Date.UTC(2026, 7, 28, 3);
  const bridge = await identity.bridgeLegacyBrowserSession(
    { id: USER.id, email: "legacy-address-is-not-authoritative@example.test", createdAt: USER.created_at },
    signingKey,
    bindings,
    now,
  );
  assert.ok(bridge?.accessToken);
  assert.ok(bridge?.refreshToken);
  assert.equal(bridge?.email, USER.email);
  assert.equal(sessions.size, 1);
  assert.deepEqual(
    await identity.userFromNativeBrowserSessionToken(bridge.accessToken, signingKey, bindings, now + 1_000),
    { id: USER.id, email: USER.email, createdAt: USER.created_at },
  );

  const next = await identity.refreshNativeBrowserSession(
    bridge.refreshToken,
    signingKey,
    bindings,
    now + 2_000,
  );
  assert.ok(next?.accessToken);
  assert.ok(next?.refreshToken);
  assert.notEqual(next?.refreshToken, bridge.refreshToken);
  assert.equal(
    await identity.refreshNativeBrowserSession(bridge.refreshToken, signingKey, bindings, now + 3_000),
    null,
    "the old one-time refresh credential is spent, rather than creating a second session",
  );
  assert.deepEqual(
    await identity.userFromNativeBrowserSessionToken(next.accessToken, signingKey, bindings, now + 3_000),
    { id: USER.id, email: USER.email, createdAt: USER.created_at },
  );
});
