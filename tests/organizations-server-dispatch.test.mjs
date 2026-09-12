/*
  lib/organizations/server.ts is a bridge, not a policy: every exported
  function here picks between the Cloudflare backend and the legacy Supabase
  RPCs (by `organizationDataMode()`), and — on the legacy side — picks which
  named RPC to call from the requested action. None of that routing was ever
  exercised behaviourally: existing coverage in tests/organizations.test.mjs
  only reads this file's source with regexes, which proves a string is
  present, not that the right branch actually runs with the right arguments.

  Two techniques cover the two backends:

  - Legacy/Supabase: `globalThis.fetch` is replaced for the width of one call
    (the same technique tests/cutover-write-barrier.test.mjs and
    tests/entitlement-cloudflare-cutover.test.mjs already use), and every
    assertion is against the captured request — which RPC name, and the exact
    body — not against a return value that could stay right while the wiring
    drifts.
  - Cloudflare: tests/cloudflare-context-stub.mjs (registered below) answers
    `getCloudflareContext()` from `globalThis.__FAKE_CLOUDFLARE_CONTEXT__`,
    which is pointed at a real in-memory D1 built from cloudflare/migrations
    (the same fixture shape tests/organisation-code-and-manager-roles.test.mjs
    uses). Delegation is proved by a real row changing in that database, not
    by a spy standing in for the real Cloudflare functions.
*/
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);
register("./cloudflare-context-stub.mjs", import.meta.url);

const ROOT = process.cwd();
const load = (...parts) => import(pathToFileURL(join(ROOT, ...parts)).href);

const server = await load("lib", "organizations", "server.ts");
const organizationCommands = await load("lib", "cloudflare", "organization-commands.ts");

/* ------------------------------------------------------------- D1 fixture -- */

function runtimeD1(database) {
  const execute = (statement) => {
    const result = database.prepare(statement.sql).run(...statement.values);
    return { success: true, results: [], meta: { changes: Number(result.changes ?? 0) } };
  };
  const bound = (sql, values) => ({
    sql,
    values,
    async run() { return execute({ sql, values }); },
    async first(column) {
      const row = database.prepare(sql).get(...values) ?? null;
      return column && row ? row[column] ?? null : row;
    },
    async all() {
      return { success: true, results: database.prepare(sql).all(...values), meta: {} };
    },
  });
  return {
    prepare(sql) {
      return { bind: (...values) => bound(sql, values), ...bound(sql, []) };
    },
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(execute);
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function fakeR2() {
  const objects = new Map();
  return {
    async put(key, value) { objects.set(key, value); },
    async get(key) {
      const value = objects.get(key);
      if (value === undefined) return null;
      return { arrayBuffer: async () => (value instanceof Uint8Array ? value.buffer : new TextEncoder().encode(value).buffer) };
    },
    async delete(key) { objects.delete(key); },
  };
}

const NOW = "2026-08-15T04:00:00.000Z";

/** A minimal, fully migrated organisation: an owner, a manager, a teacher, one student. */
function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(ROOT, "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(ROOT, "cloudflare", "migrations", file), "utf8"));
  }

  const organizationId = "11111111-1111-4111-8111-111111111111";
  const users = {
    owner: { id: "50000000-0000-4000-8000-000000000001", email: "owner@example.test" },
    manager: { id: "50000000-0000-4000-8000-000000000002", email: "manager@example.test" },
    teacher: { id: "50000000-0000-4000-8000-000000000003", email: "teacher@example.test" },
    student: { id: "50000000-0000-4000-8000-000000000004", email: "student@example.test" },
  };

  const insertUser = database.prepare(`
    INSERT INTO app_users (id, email, role, created_at, updated_at) VALUES (?, ?, 'user', ?, ?)
  `);
  for (const user of Object.values(users)) insertUser.run(user.id, user.email, NOW, NOW);

  database.prepare(`
    INSERT INTO organizations (
      id, application_id, name, slug, status, created_by, created_at, updated_at, join_code
    ) VALUES (?, NULL, 'Test Academy', NULL, 'active', ?, ?, ?, 'testacademyjoincode')
  `).run(organizationId, users.owner.id, NOW, NOW);

  const insertMembership = database.prepare(`
    INSERT INTO organization_memberships (
      id, organization_id, user_id, role, status,
      share_future_history, share_pre_join_history, joined_at,
      created_at, updated_at, status_changed_at
    ) VALUES (?, ?, ?, ?, 'active', 1, 0, ?, ?, ?, ?)
  `);
  let membershipSeq = 0;
  for (const [role, user] of Object.entries(users)) {
    membershipSeq += 1;
    insertMembership.run(`7000000${membershipSeq}-0000-4000-8000-000000000001`, organizationId, user.id, role, NOW, NOW, NOW, NOW);
  }

  // The student needs an eligible plan: studentEligible() gates that
  // regardless of how the membership itself was reached (see the identical
  // note in tests/organisation-code-and-manager-roles.test.mjs).
  database.prepare(`
    INSERT INTO subscriptions (id, user_id, provider, status, tier, verified_at, created_at, updated_at)
    VALUES ('71000000-0000-4000-8000-000000000001', ?, 'stripe', 'active', 'tracking', ?, ?, ?)
  `).run(users.student.id, NOW, NOW, NOW);

  return { database, organizationId, users, bindings: { db: runtimeD1(database), files: fakeR2() } };
}

/* --------------------------------------------------------- env/fetch/D1 rigs -- */

function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

const SUPABASE_CONFIG = {
  SUPABASE_URL: "https://project.supabase.test",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

/** Replaces globalThis.fetch; `handler(url, body, callNumber)` answers every call. */
function withStubbedFetch(handler, fn) {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    return handler(String(url), body, calls.length);
  };
  return Promise.resolve().then(() => fn(calls)).finally(() => { globalThis.fetch = saved; });
}

const okResponse = () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });

function withFakeCloudflareContext(bindings, fn) {
  const previous = globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
  globalThis.__FAKE_CLOUDFLARE_CONTEXT__ = { env: { BANDUP_DB: bindings.db, BANDUP_FILES: bindings.files } };
  return Promise.resolve().then(fn).finally(() => {
    if (previous === undefined) delete globalThis.__FAKE_CLOUDFLARE_CONTEXT__;
    else globalThis.__FAKE_CLOUDFLARE_CONTEXT__ = previous;
  });
}

/* ============================================================ organizationPortal == */

test("organizationPortal delegates to the Cloudflare backend when the organisation data mode says so", async () => {
  const fx = fixture();
  try {
    await withEnv({ ORGANIZATION_DATA_MODE: "cloudflare" }, () => withFakeCloudflareContext(fx.bindings, async () => {
      const portal = await server.organizationPortal(fx.users.owner, null);
      // Only a real Cloudflare portal read returns this organisation's own
      // join code; the legacy RPC path (unconfigured in this test) would
      // have thrown instead of answering at all.
      assert.equal(portal.joinCode, "testacademyjoincode");
    }));
  } finally {
    fx.database.close();
  }
});

test("organizationPortal asks the legacy RPCs outside Cloudflare mode, choosing by whether an organisation is selected", async () => {
  await withEnv({ ORGANIZATION_DATA_MODE: undefined, ...SUPABASE_CONFIG }, () => withStubbedFetch(okResponse, async (calls) => {
    const user = { id: "user-portal-1", email: "learner@example.test" };

    await server.organizationPortal(user, "org-42");
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rpc\/organization_portal_selected$/);
    assert.deepEqual(calls[0].body, {
      p_actor: "user-portal-1", p_platform_admin: false, p_organization: "org-42",
    });

    calls.length = 0;
    await server.organizationPortal(user, null);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rpc\/organization_portal_with_former_memberships$/);
    assert.deepEqual(calls[0].body, { p_actor: "user-portal-1", p_platform_admin: false });
  }));
});

/* ===================================================== organizationHomeShortcut == */

test("organizationHomeShortcut delegates to the Cloudflare backend when the organisation data mode says so", async () => {
  const fx = fixture();
  try {
    // cloudflareOrganizationHomeShortcut and cloudflareOrganizationPortal (via
    // organizationPortal) can both resolve the same teacher to the same
    // organisation for this fixture, so a matching return value alone would
    // not tell the two apart. What must differ is which query ran: the
    // dedicated shortcut is one light SELECT, and the full portal read is the
    // only one of the two that ever touches learner_profiles. Logging the SQL
    // this call issues is what actually proves which path ran.
    const queries = [];
    const db = fx.bindings.db;
    const loggedBindings = { ...fx.bindings, db: { ...db, prepare(sql) { queries.push(sql); return db.prepare(sql); } } };
    await withEnv({ ORGANIZATION_DATA_MODE: "cloudflare" }, () => withFakeCloudflareContext(loggedBindings, async () => {
      const shortcut = await server.organizationHomeShortcut(fx.users.teacher);
      assert.equal(shortcut?.id, fx.organizationId);
      assert.equal(shortcut?.role, "teacher");
      assert.ok(
        !queries.some((sql) => sql.includes("learner_profiles")),
        "must use the dedicated home-shortcut query, not the full portal read",
      );
    }));
  } finally {
    fx.database.close();
  }
});

test("organizationHomeShortcut falls back to the legacy portal RPC, and picks the active organisation from its own reply", async () => {
  const portalPayload = {
    activeOrganizationId: "org-9",
    memberships: [{
      status: "active",
      role: "teacher",
      organization: { id: "org-9", name: "Legacy Academy", status: "active", memberCount: 5, studentCount: 3 },
    }],
  };
  await withEnv({ ORGANIZATION_DATA_MODE: undefined, ...SUPABASE_CONFIG }, () => withStubbedFetch(
    () => new Response(JSON.stringify(portalPayload), { status: 200, headers: { "Content-Type": "application/json" } }),
    async (calls) => {
      const user = { id: "user-home-1", email: "learner2@example.test" };
      const shortcut = await server.organizationHomeShortcut(user);
      assert.deepEqual(shortcut, {
        id: "org-9", name: "Legacy Academy", role: "teacher", memberCount: 5, studentCount: 3,
      });
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/rpc\/organization_portal_with_former_memberships$/);
    },
  ));
});

/* ========================================================== organizationCommand == */

test("organizationCommand delegates to the Cloudflare command bus when the organisation data mode says so", async () => {
  const fx = fixture();
  try {
    await withEnv({ ORGANIZATION_DATA_MODE: "cloudflare" }, () => withFakeCloudflareContext(fx.bindings, async () => {
      const response = await server.organizationCommand(
        fx.users.manager,
        "change_member_role",
        { organizationId: fx.organizationId, userId: fx.users.teacher.id, role: "manager" },
        "idem-cloudflare-promote-01",
      );
      assert.equal(response.ok, true);
      const row = fx.database.prepare(
        "SELECT role FROM organization_memberships WHERE organization_id = ? AND user_id = ?",
      ).get(fx.organizationId, fx.users.teacher.id);
      // Only a real write through the Cloudflare command bus changes this row;
      // the legacy path (unconfigured here) would have thrown instead.
      assert.equal(row.role, "manager");
    }));
  } finally {
    fx.database.close();
  }
});

test("organizationCommand refuses to create an organisation outside Cloudflare data mode, and never asks Supabase to", async () => {
  await withEnv({ ORGANIZATION_DATA_MODE: undefined, ...SUPABASE_CONFIG }, () => withStubbedFetch(okResponse, async (calls) => {
    const user = { id: "user-create-1", email: "learner3@example.test" };
    await assert.rejects(
      server.organizationCommand(user, "create_organization", {}, "idem-create-organization-1"),
      (error) => error instanceof organizationCommands.OrganizationCommandError
        && error.message === "Creating an organisation requires the Cloudflare organisation data mode.",
    );
    assert.equal(calls.length, 0, "must not reach Supabase for create_organization");
  }));
});

test("organizationCommand routes join/accept consent actions to the consent RPC, and set_prior_history_sharing to its own", async () => {
  await withEnv({ ORGANIZATION_DATA_MODE: undefined, ...SUPABASE_CONFIG }, () => withStubbedFetch(okResponse, async (calls) => {
    const user = { id: "user-consent-1", email: "learner4@example.test" };
    const payload = { code: "abc123" };

    await server.organizationCommand(user, "request_to_join", payload, "idem-consent-join-00001");
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rpc\/organization_consent_command$/);
    assert.deepEqual(calls[0].body, {
      p_actor: "user-consent-1", p_platform_admin: false, p_action: "request_to_join",
      p_payload: payload, p_idempotency_key: "idem-consent-join-00001",
    });

    calls.length = 0;
    await server.organizationCommand(user, "accept_invitation", payload, "idem-consent-accept-0001");
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rpc\/organization_consent_command$/);
    assert.deepEqual(calls[0].body, {
      p_actor: "user-consent-1", p_platform_admin: false, p_action: "accept_invitation",
      p_payload: payload, p_idempotency_key: "idem-consent-accept-0001",
    });

    // A third, unrelated action must land in its own branch below, not here.
    calls.length = 0;
    await server.organizationCommand(user, "set_prior_history_sharing", payload, "idem-sharing-branch-0001");
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rpc\/organization_history_sharing_command$/);
    assert.deepEqual(calls[0].body, {
      p_actor: "user-consent-1", p_platform_admin: false,
      p_payload: payload, p_idempotency_key: "idem-sharing-branch-0001",
    });
  }));
});

test("organizationCommand routes invite_member only when the payload actually names a string target user", async () => {
  await withEnv({ ORGANIZATION_DATA_MODE: undefined, ...SUPABASE_CONFIG }, () => withStubbedFetch(okResponse, async (calls) => {
    const user = { id: "user-invite-1", email: "learner5@example.test" };

    await server.organizationCommand(user, "invite_member", {
      organizationId: "org-5", userId: "target-5", role: "teacher", token: "tok-5",
    }, "idem-invite-role-000001");
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rpc\/organization_invite_account$/);
    assert.deepEqual(calls[0].body, {
      p_actor: "user-invite-1", p_platform_admin: false, p_organization: "org-5",
      p_target: "target-5", p_role: "teacher", p_token: "tok-5",
      p_idempotency_key: "idem-invite-role-000001",
    });

    // No role given: defaults to "student", not left blank or dropped.
    calls.length = 0;
    await server.organizationCommand(user, "invite_member", {
      organizationId: "org-5", userId: "target-5", token: "tok-5",
    }, "idem-invite-default-000001");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, {
      p_actor: "user-invite-1", p_platform_admin: false, p_organization: "org-5",
      p_target: "target-5", p_role: "student", p_token: "tok-5",
      p_idempotency_key: "idem-invite-default-000001",
    });

    // No (string) userId at all: this is not a target the branch may act on,
    // so it must fall through to the generic bridge rather than send a
    // broken invite with an undefined target.
    calls.length = 0;
    await server.organizationCommand(user, "invite_member", {
      organizationId: "org-5",
    }, "idem-invite-missing-000001");
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rpc\/organization_command$/);

    // And invite_account is never reached for a different action, even one
    // whose payload happens to carry a string userId of its own.
    calls.length = 0;
    await server.organizationCommand(user, "remove_member", {
      organizationId: "org-5", userId: "target-5",
    }, "idem-remove-member-000001");
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rpc\/organization_command$/);
  }));
});

test("organizationCommand validates a teacher batch assignment's shape before routing it, atomically", async () => {
  await withEnv({ ORGANIZATION_DATA_MODE: undefined, ...SUPABASE_CONFIG }, () => withStubbedFetch(okResponse, async (calls) => {
    const user = { id: "user-batch-1", email: "learner6@example.test" };
    const validPayload = {
      organizationId: "org-6", teacherUserId: "teacher-6", studentUserIds: ["student-6a", "student-6b"],
    };

    await server.organizationCommand(user, "assign_teacher_batch", validPayload, "idem-batch-valid-0000001");
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rpc\/organization_assign_teacher_batch$/);
    assert.deepEqual(calls[0].body, {
      p_actor: "user-batch-1", p_platform_admin: false, p_organization: "org-6",
      p_teacher: "teacher-6", p_students: ["student-6a", "student-6b"],
      p_idempotency_key: "idem-batch-valid-0000001",
    });

    calls.length = 0;
    for (const invalid of [
      { ...validPayload, organizationId: 42 },
      { ...validPayload, teacherUserId: 42 },
      { ...validPayload, studentUserIds: "student-6a" },
    ]) {
      await assert.rejects(
        server.organizationCommand(user, "assign_teacher_batch", invalid, "idem-batch-invalid-000001"),
        /^Error: Invalid teacher assignment\.$/,
      );
    }
    assert.equal(calls.length, 0, "an invalid batch must never reach the RPC bus");
  }));
});

test("organizationCommand bridges every other action straight through to the generic RPC, unchanged", async () => {
  await withEnv({ ORGANIZATION_DATA_MODE: undefined, ...SUPABASE_CONFIG }, () => withStubbedFetch(okResponse, async (calls) => {
    const user = { id: "user-bridge-1", email: "learner7@example.test" };
    const payload = { organizationId: "org-7", attemptId: "attempt-7" };
    await server.organizationCommand(user, "archive_attempt", payload, "idem-bridge-generic-0001");
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rpc\/organization_command$/);
    assert.deepEqual(calls[0].body, {
      p_actor: "user-bridge-1", p_platform_admin: false, p_action: "archive_attempt",
      p_payload: payload, p_idempotency_key: "idem-bridge-generic-0001",
    });
  }));
});

/* ===================================================== organizationStudentHistory == */

test("organizationStudentHistory delegates to the Cloudflare backend when the organisation data mode says so", async () => {
  const fx = fixture();
  try {
    await withEnv({ ORGANIZATION_DATA_MODE: "cloudflare" }, () => withFakeCloudflareContext(fx.bindings, async () => {
      const history = await server.organizationStudentHistory(
        fx.users.manager, fx.users.student.id, fx.organizationId, null,
      );
      assert.equal(history.organization.id, fx.organizationId);
      assert.deepEqual(history.attempts, []);
    }));
  } finally {
    fx.database.close();
  }
});

test("organizationStudentHistory refuses an explicit organisation outside Cloudflare data mode, and otherwise asks the legacy RPC", async () => {
  await withEnv({ ORGANIZATION_DATA_MODE: undefined, ...SUPABASE_CONFIG }, () => withStubbedFetch(okResponse, async (calls) => {
    const user = { id: "user-history-1", email: "learner8@example.test" };

    await assert.rejects(
      server.organizationStudentHistory(user, "student-8", "org-8", null),
      /^Error: Selecting an organization for student history requires Cloudflare data mode\.$/,
    );
    assert.equal(calls.length, 0);

    await server.organizationStudentHistory(user, "student-8", null, null);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rpc\/organization_student_history$/);
    assert.deepEqual(calls[0].body, { p_actor: "user-history-1", p_platform_admin: false, p_student: "student-8" });
  }));
});

/* ======================================================= syncOrganizationAttempts == */

const READING_ATTEMPT = {
  module: "reading", testId: "reading-1", testTitle: "The lighthouse", band: 7, date: "2026-08-10T09:00:00.000Z",
};
const LISTENING_ATTEMPT = {
  module: "listening", testId: "listening-1", testTitle: "A talk", band: 6.5, date: "2026-08-11T09:00:00.000Z",
};

test("syncOrganizationAttempts short-circuits to true only when there is truly nothing to sync", async () => {
  // Nothing at all is configured (no data mode, no Supabase config, no
  // Cloudflare context): reaching any backend would throw immediately, so a
  // clean resolved `true` is only possible via the early return.
  const ok = await server.syncOrganizationAttempts(
    { id: "user-noop-1", email: "noop@example.test" }, [], "idem-noop-000001", null,
  );
  assert.equal(ok, true);
});

test("an empty attempt list still reaches the backend when a history-clear watermark is present", async () => {
  const fx = fixture();
  try {
    await withEnv({ ORGANIZATION_DATA_MODE: "cloudflare" }, () => withFakeCloudflareContext(fx.bindings, async () => {
      const ok = await server.syncOrganizationAttempts(
        fx.users.student, [], "idem-watermark-only-0001", "2026-08-20T00:00:00.000Z",
      );
      assert.equal(ok, true);
      const watermark = fx.database.prepare(
        "SELECT cleared_at FROM organization_history_clear_watermarks WHERE user_id = ?",
      ).get(fx.users.student.id);
      assert.ok(watermark, "the watermark must actually be written — proof the sync ran rather than short-circuiting");
      assert.equal(watermark.cleared_at, "2026-08-20T00:00:00.000Z");
    }));
  } finally {
    fx.database.close();
  }
});

test("syncOrganizationAttempts delegates to the Cloudflare backend when the organisation data mode says so", async () => {
  const fx = fixture();
  try {
    await withEnv({ ORGANIZATION_DATA_MODE: "cloudflare" }, () => withFakeCloudflareContext(fx.bindings, async () => {
      const ok = await server.syncOrganizationAttempts(fx.users.student, [READING_ATTEMPT], "idem-cf-sync-00000001", null);
      assert.equal(ok, true);
      const row = fx.database.prepare(
        "SELECT module, band FROM practice_attempts WHERE user_id = ?",
      ).get(fx.users.student.id);
      assert.ok(row, "the attempt must actually have been written to D1");
      assert.equal(row.module, "reading");
      assert.equal(row.band, 7);
    }));
  } finally {
    fx.database.close();
  }
});

test("syncOrganizationAttempts converts a Cloudflare backend failure into a plain false, never a rejection", async () => {
  // A D1 handle with no migrations applied: any real query against it throws
  // "no such table", which is exactly the failure this try/catch exists to
  // turn into a reportable `false` instead of an unhandled rejection. A
  // working legacy RPC is stubbed alongside it so a caught-but-then-silently-
  // falls-through bug would be caught too: it would find the legacy RPC ready
  // and answer `true` from *there* instead, which is just as wrong as an
  // uncaught rejection would be — this function must answer `false` itself,
  // not stumble into the right-looking answer by asking someone else.
  const database = new DatabaseSync(":memory:");
  const bindings = { db: runtimeD1(database), files: fakeR2() };
  try {
    await withEnv(
      { ORGANIZATION_DATA_MODE: "cloudflare", ...SUPABASE_CONFIG },
      () => withFakeCloudflareContext(bindings, () => withStubbedFetch(okResponse, async (calls) => {
        const ok = await server.syncOrganizationAttempts(
          { id: "user-broken-1", email: "broken@example.test" }, [READING_ATTEMPT], "idem-cf-broken-0000001", null,
        );
        assert.equal(ok, false);
        assert.equal(calls.length, 0, "a Cloudflare failure must be reported directly, not by falling through to the legacy RPC");
      })),
    );
  } finally {
    database.close();
  }
});

test("syncOrganizationAttempts only calls the legacy RPC when there are attempts, and mirrors to Cloudflare only in dual mode", async () => {
  const fx = fixture();
  try {
    await withEnv(
      { ORGANIZATION_DATA_MODE: "supabase", ...SUPABASE_CONFIG },
      () => withFakeCloudflareContext(fx.bindings, () => withStubbedFetch(okResponse, async (calls) => {
        const ok = await server.syncOrganizationAttempts(
          fx.users.student, [LISTENING_ATTEMPT], "idem-legacy-supabase-0001", null,
        );
        assert.equal(ok, true);
        assert.equal(calls.length, 1);
        assert.match(calls[0].url, /\/rpc\/organization_sync_attempts$/);
        assert.deepEqual(calls[0].body, {
          p_actor: fx.users.student.id, p_attempts: [LISTENING_ATTEMPT], p_idempotency_key: "idem-legacy-supabase-0001",
        });
        assert.equal(
          fx.database.prepare("SELECT count(*) AS n FROM practice_attempts WHERE user_id = ?").get(fx.users.student.id).n,
          0,
          "plain supabase mode must never also write to D1",
        );

        // An empty attempt list, still in supabase mode: the RPC must not be
        // called with nothing to report, even though a watermark is present
        // (the dedicated watermark-only test above covers the cloudflare side).
        calls.length = 0;
        const okEmpty = await server.syncOrganizationAttempts(
          fx.users.student, [], "idem-legacy-supabase-empty1", "2026-08-11T00:00:00.000Z",
        );
        assert.equal(okEmpty, true);
        assert.equal(calls.length, 0, "an empty attempt list must not call the RPC even with a watermark present");
      })),
    );
  } finally {
    fx.database.close();
  }

  const dualFixture = fixture();
  try {
    await withEnv(
      { ORGANIZATION_DATA_MODE: "dual", ...SUPABASE_CONFIG },
      () => withFakeCloudflareContext(dualFixture.bindings, () => withStubbedFetch(okResponse, async (calls) => {
        const ok = await server.syncOrganizationAttempts(
          dualFixture.users.student, [LISTENING_ATTEMPT], "idem-legacy-dual-00001", null,
        );
        assert.equal(ok, true);
        assert.equal(calls.length, 1, "the legacy RPC must still be asked in dual mode");
        assert.match(calls[0].url, /\/rpc\/organization_sync_attempts$/);
        // The entire reason "dual" mode exists: it also mirrors to D1.
        assert.equal(
          dualFixture.database.prepare(
            "SELECT count(*) AS n FROM practice_attempts WHERE user_id = ?",
          ).get(dualFixture.users.student.id).n,
          1,
          "dual mode must also mirror the attempt into D1",
        );
      })),
    );
  } finally {
    dualFixture.database.close();
  }
});

test("syncOrganizationAttempts converts a legacy RPC failure into a plain false, never a rejection", async () => {
  await withEnv({ ORGANIZATION_DATA_MODE: undefined, ...SUPABASE_CONFIG }, () => withStubbedFetch(
    () => new Response("failure", { status: 500 }),
    async () => {
      const ok = await server.syncOrganizationAttempts(
        { id: "user-legacy-fail-1", email: "legacyfail@example.test" }, [READING_ATTEMPT], "idem-legacy-fail-0000001", null,
      );
      assert.equal(ok, false);
    },
  ));
});
