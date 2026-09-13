import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);
const commands = await load("lib", "cloudflare", "organization-commands.ts");

/*
  Same runtime D1 shim tests/organisation-code-and-manager-roles.test.mjs and
  tests/open-organisation-creation.test.mjs already use: a real in-memory
  SQLite database (via node:sqlite) driven through the same prepare/bind/run/
  first/all/batch surface the Worker's D1 binding exposes, so the command
  module never knows it isn't talking to D1.
*/
function runtimeD1(database) {
  const result = (statement) => {
    const executed = database.prepare(statement.sql).run(...statement.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(executed.changes ?? 0) },
    };
  };
  const bound = (sql, values) => ({
    sql,
    values,
    async run() {
      return result({ sql, values });
    },
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
      return {
        bind: (...values) => bound(sql, values),
        ...bound(sql, []),
      };
    },
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(result);
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/*
  Timestamps fall in two families that must never be mixed:

  - FIXTURE_NOW is used only for created_at/updated_at/joined_at columns that
    the source code compares against *each other* (e.g. an attempt's
    submitted_at against a membership's joined_at). Those comparisons never
    touch the real clock.
  - FAR_PAST/FAR_FUTURE anchor anything the source compares against its own
    `stamp()` (real `new Date().toISOString()`), such as a seat pool's
    ends_at, a subscription's current_period_end, or a lock's expires_at.
    Using dates far on either side of "now" keeps the suite from ever racing
    the real clock the test happens to run under.
*/
const FIXTURE_NOW = "2026-08-15T04:00:00.000Z";
const FAR_PAST = "2020-01-01T00:00:00.000Z";
const FAR_FUTURE = "2035-01-01T00:00:00.000Z";

const ids = {
  org: "11111111-1111-4111-8111-111111111111",
  orgSuspended: "11111111-1111-4111-8111-111111111112",
  orgClosed: "11111111-1111-4111-8111-111111111113",

  owner: "50000000-0000-4000-8000-000000000001",
  manager: "50000000-0000-4000-8000-000000000002",
  manager2: "50000000-0000-4000-8000-000000000003",
  teacher: "50000000-0000-4000-8000-000000000004",
  teacher2: "50000000-0000-4000-8000-000000000005",
  student: "50000000-0000-4000-8000-000000000006",
  student2: "50000000-0000-4000-8000-000000000007",
  student3: "50000000-0000-4000-8000-000000000008",
  suspendedStudent: "50000000-0000-4000-8000-000000000009",
  suspendedTeacher: "50000000-0000-4000-8000-000000000010",
  removedStudent: "50000000-0000-4000-8000-000000000011",
  leaveReqStudent: "50000000-0000-4000-8000-000000000012",
  pendingStudent: "50000000-0000-4000-8000-000000000013",
  outsider: "50000000-0000-4000-8000-000000000014",
  outsider2: "50000000-0000-4000-8000-000000000015",
  ineligible: "50000000-0000-4000-8000-000000000016",
  memberNoSub: "50000000-0000-4000-8000-000000000017",
  legacyTierOutsider: "50000000-0000-4000-8000-000000000018",
  admin: "90000000-0000-4000-8000-000000000001",
};

function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(process.cwd(), "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "cloudflare", "migrations", file), "utf8"));
  }

  const insertUser = database.prepare(`
    INSERT INTO app_users (id, email, role, created_at, updated_at)
    VALUES (?, ?, 'user', ?, ?)
  `);
  // The email must match context.user(id)'s own convention below: several
  // commands (accept_invitation's email match, invite_member's account
  // lookup) compare against exactly one of these two values, and ensureCloudflareUser
  // would otherwise silently rewrite this row's email the first time its
  // owner ever acts, making a test's outcome depend on call order.
  for (const [, id] of Object.entries(ids)) {
    insertUser.run(id, `${id}@example.com`, FIXTURE_NOW, FIXTURE_NOW);
  }

  database.prepare(`
    INSERT INTO organizations (id, application_id, name, slug, status, created_by, created_at, updated_at, join_code)
    VALUES (?, NULL, 'Harbour Academy', NULL, 'active', ?, ?, ?, 'orgjoincode1234')
  `).run(ids.org, ids.owner, FIXTURE_NOW, FIXTURE_NOW);
  database.prepare(`
    INSERT INTO organizations (id, application_id, name, slug, status, created_by, created_at, updated_at, join_code)
    VALUES (?, NULL, 'Suspended Academy', NULL, 'suspended', ?, ?, ?, NULL)
  `).run(ids.orgSuspended, ids.owner, FIXTURE_NOW, FIXTURE_NOW);
  database.prepare(`
    INSERT INTO organizations (id, application_id, name, slug, status, created_by, created_at, updated_at, join_code)
    VALUES (?, NULL, 'Closed Academy', NULL, 'closed', ?, ?, ?, NULL)
  `).run(ids.orgClosed, ids.owner, FIXTURE_NOW, FIXTURE_NOW);

  const insertMembership = database.prepare(`
    INSERT INTO organization_memberships (
      id, organization_id, user_id, role, status,
      share_future_history, share_pre_join_history, joined_at,
      created_at, updated_at, status_changed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let membershipSeq = 0;
  const seatMember = (organizationId, userId, role, status, options = {}) => {
    membershipSeq += 1;
    insertMembership.run(
      `70000000-0000-4000-8000-${String(membershipSeq).padStart(12, "0")}`,
      organizationId,
      userId,
      role,
      status,
      options.shareFuture ?? 1,
      options.sharePreJoin ?? 0,
      "joinedAt" in options ? options.joinedAt : FIXTURE_NOW,
      FIXTURE_NOW,
      FIXTURE_NOW,
      FIXTURE_NOW,
    );
  };
  seatMember(ids.org, ids.owner, "owner", "active");
  seatMember(ids.org, ids.manager, "manager", "active");
  seatMember(ids.org, ids.manager2, "manager", "active");
  seatMember(ids.org, ids.teacher, "teacher", "active");
  seatMember(ids.org, ids.teacher2, "teacher", "active");
  seatMember(ids.org, ids.student, "student", "active");
  seatMember(ids.org, ids.student2, "student", "active");
  seatMember(ids.org, ids.student3, "student", "active");
  seatMember(ids.org, ids.suspendedStudent, "student", "suspended");
  seatMember(ids.org, ids.suspendedTeacher, "teacher", "suspended");
  seatMember(ids.org, ids.removedStudent, "student", "removed", { sharePreJoin: 1 });
  seatMember(ids.org, ids.leaveReqStudent, "student", "leave_requested");
  seatMember(ids.org, ids.pendingStudent, "student", "pending", { joinedAt: null });
  // A real member with no subscription, kept separate from ids.ineligible
  // (which stays a non-member so invite/join/accept eligibility tests do not
  // also have to fight an existing-membership conflict).
  seatMember(ids.org, ids.memberNoSub, "teacher", "active");
  // A manager of a *second*, suspended organisation — needed to prove the
  // suspended-visibility rule is about the organisation being acted on, not
  // about whether the actor can manage in general.
  seatMember(ids.orgSuspended, ids.manager, "manager", "active");

  database.prepare(`
    INSERT INTO teacher_student_assignments (id, organization_id, teacher_user_id, student_user_id, assigned_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("72000000-0000-4000-8000-000000000001", ids.org, ids.teacher, ids.student, ids.manager, FIXTURE_NOW);

  const insertSubscription = database.prepare(`
    INSERT INTO subscriptions (
      id, user_id, provider, status, tier, current_period_end, verified_at, created_at, updated_at
    ) VALUES (?, ?, 'stripe', 'active', 'tracking', ?, ?, ?, ?)
  `);
  let subscriptionSeq = 0;
  const eligible = (userId, currentPeriodEnd = null) => {
    subscriptionSeq += 1;
    insertSubscription.run(
      `71000000-0000-4000-8000-${String(subscriptionSeq).padStart(12, "0")}`,
      userId,
      currentPeriodEnd,
      FIXTURE_NOW,
      FIXTURE_NOW,
      FIXTURE_NOW,
    );
  };
  for (const id of [
    ids.student, ids.student2, ids.student3, ids.teacher, ids.teacher2, ids.manager2,
    ids.removedStudent, ids.leaveReqStudent, ids.pendingStudent, ids.outsider, ids.outsider2,
    ids.suspendedStudent,
  ]) eligible(id);
  // `ids.ineligible` deliberately has no subscription and no seat allocation.
  // `ids.legacyTierOutsider` holds a subscription row still spelled with a
  // retired tier name ("plus", from before the tracking/ai rename) rather
  // than the current "ai" it canonicalises to -- exactly what a subscription
  // never rewritten since checkout looks like.
  database.prepare(`
    INSERT INTO subscriptions (
      id, user_id, provider, status, tier, current_period_end, verified_at, created_at, updated_at
    ) VALUES (?, ?, 'stripe', 'active', 'plus', NULL, ?, ?, ?)
  `).run("71000000-0000-4000-8000-999999999999", ids.legacyTierOutsider, FIXTURE_NOW, FIXTURE_NOW, FIXTURE_NOW);

  const insertAttempt = database.prepare(`
    INSERT INTO practice_attempts (
      id, user_id, module, test_id, test_title, submitted_at,
      result_inline, result_sha256, result_bytes, created_at, updated_at
    ) VALUES (?, ?, 'reading', ?, 'Reading test', ?, '{}', ?, 2, ?, ?)
  `);
  const attemptIds = {
    shareable: "80000000-0000-4000-8000-000000000001",
    outOfScope: "80000000-0000-4000-8000-000000000002",
    tombstoned: "80000000-0000-4000-8000-000000000003",
  };
  insertAttempt.run(attemptIds.shareable, ids.student, "r-shareable", "2026-08-16T00:00:00.000Z", "a".repeat(64), FIXTURE_NOW, FIXTURE_NOW);
  insertAttempt.run(attemptIds.outOfScope, ids.student, "r-out-of-scope", "2026-08-01T00:00:00.000Z", "b".repeat(64), FIXTURE_NOW, FIXTURE_NOW);
  insertAttempt.run(attemptIds.tombstoned, ids.student, "r-tombstoned", "2026-08-16T00:00:00.000Z", "c".repeat(64), FIXTURE_NOW, FIXTURE_NOW);
  database.prepare(`
    INSERT INTO organization_attempt_tombstones (organization_id, attempt_id, student_user_id, removed_by, reason, removed_at)
    VALUES (?, ?, ?, ?, 'seed tombstone', ?)
  `).run(ids.org, attemptIds.tombstoned, ids.student, ids.owner, FIXTURE_NOW);

  const seatPoolIds = {
    full: "60000000-0000-4000-8000-000000000001",
    expired: "60000000-0000-4000-8000-000000000002",
    forRelease: "60000000-0000-4000-8000-000000000003",
  };
  database.prepare(`
    INSERT INTO organization_seat_pools (id, organization_id, provider, seat_count, starts_at, ends_at, status, created_at, updated_at)
    VALUES (?, ?, 'manual', 1, ?, NULL, 'active', ?, ?)
  `).run(seatPoolIds.full, ids.org, FIXTURE_NOW, FIXTURE_NOW, FIXTURE_NOW);
  database.prepare(`
    INSERT INTO organization_seat_allocations (id, organization_id, seat_pool_id, user_id, status, starts_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
  `).run("61000000-0000-4000-8000-000000000001", ids.org, seatPoolIds.full, ids.student2, FIXTURE_NOW, FIXTURE_NOW, FIXTURE_NOW);
  database.prepare(`
    INSERT INTO organization_seat_pools (id, organization_id, provider, seat_count, starts_at, ends_at, status, created_at, updated_at)
    VALUES (?, ?, 'manual', 5, ?, ?, 'active', ?, ?)
  `).run(seatPoolIds.expired, ids.org, FIXTURE_NOW, FAR_PAST, FIXTURE_NOW, FIXTURE_NOW);
  database.prepare(`
    INSERT INTO organization_seat_pools (id, organization_id, provider, seat_count, starts_at, ends_at, status, created_at, updated_at)
    VALUES (?, ?, 'manual', 5, ?, NULL, 'active', ?, ?)
  `).run(seatPoolIds.forRelease, ids.org, FIXTURE_NOW, FIXTURE_NOW, FIXTURE_NOW);
  database.prepare(`
    INSERT INTO organization_seat_allocations (id, organization_id, seat_pool_id, user_id, status, starts_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
  `).run("61000000-0000-4000-8000-000000000002", ids.org, seatPoolIds.forRelease, ids.outsider, FIXTURE_NOW, FIXTURE_NOW, FIXTURE_NOW);

  const batches = [];
  const real = runtimeD1(database);
  const db = {
    prepare: (sql) => real.prepare(sql),
    async batch(statements) {
      batches.push(statements.map((statement) => ({ sql: statement.sql, values: statement.values })));
      return real.batch(statements);
    },
  };

  return {
    database,
    batches,
    bindings: { db, files: {} },
    attemptIds,
    seatPoolIds,
    user(id) {
      return { id, email: `${id}@example.com` };
    },
  };
}

let keySeq = 0;
function nextKey(label) {
  keySeq += 1;
  return `idem-${label}-${keySeq}`;
}

function act(context, userId, platformAdmin, action, payload, label) {
  return commands.cloudflareOrganizationCommand(
    context.user(userId), platformAdmin, action, payload, nextKey(label), context.bindings,
  );
}

async function expectDenied(promise, status, code, message) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof commands.OrganizationCommandError, "must throw OrganizationCommandError");
    assert.equal(error.status, status, "status code");
    assert.equal(error.code, code, "error code");
    if (message !== undefined) assert.equal(error.message, message, "error message");
    return true;
  });
}

function membershipRow(context, organizationId, userId) {
  return context.database.prepare(`
    SELECT role, status, share_future_history, share_pre_join_history, joined_at, removed_at
      FROM organization_memberships WHERE organization_id = ? AND user_id = ?
  `).get(organizationId, userId);
}

function auditRows(context, action) {
  return context.database.prepare(`
    SELECT organization_id, actor_user_id, target_type, target_id, metadata_json
      FROM organization_audit_log WHERE action = ? ORDER BY created_at
  `).all(action);
}

function requestRow(context, requestId) {
  return context.database.prepare(`SELECT * FROM organization_requests WHERE id = ?`).get(requestId);
}

// ---------------------------------------------------------------------------
// Module-level regexes (lines 68-70) and OrganizationCommandError (78-92)
// ---------------------------------------------------------------------------

test("the idempotency key regex is fully anchored, not merely a substring match", async () => {
  const context = fixture();
  try {
    // Removing the leading ^ would let a valid 12-120 char run *anywhere in
    // the tail* satisfy the regex even though the string starts with noise.
    await expectDenied(
      commands.cloudflareOrganizationCommand(
        context.user(ids.owner), false, "create_organization", { organizationName: "Anchor Co" },
        `!!!${"a".repeat(13)}`, context.bindings,
      ),
      400, "validation", "Invalid request identifier.",
    );
    // Removing the trailing $ would let a valid run *at the start* satisfy the
    // regex even though invalid characters follow it.
    await expectDenied(
      commands.cloudflareOrganizationCommand(
        context.user(ids.owner), false, "create_organization", { organizationName: "Anchor Co" },
        `${"a".repeat(13)}!!!`, context.bindings,
      ),
      400, "validation", "Invalid request identifier.",
    );
  } finally {
    context.database.close();
  }
});

test("the organisation/account id regex is fully anchored", async () => {
  const context = fixture();
  try {
    const real = ids.org;
    await expectDenied(
      act(context, ids.admin, true, "suspend_organization", { organizationId: `zz${real}` }, "id-anchor"),
      400, "validation", "Invalid organisation.",
    );
    await expectDenied(
      act(context, ids.admin, true, "suspend_organization", { organizationId: `${real}zz` }, "id-anchor"),
      400, "validation", "Invalid organisation.",
    );
  } finally {
    context.database.close();
  }
});

test("the invitation email regex is fully anchored against surrounding noise", async () => {
  const context = fixture();
  try {
    // "email@x.co" is a valid address hiding at the *end* of a string whose
    // start could never match on its own — only an unanchored ^ lets it in.
    await expectDenied(
      act(context, ids.manager, false, "invite_member", {
        organizationId: ids.org, role: "student", token: "a".repeat(24), email: "not an email@x.co",
      }, "email-anchor-start"),
      400, "validation", "Invalid invitation email.",
    );
    // "a@b.co" is a valid address at the *start* of a string with trailing
    // noise — only an unanchored $ lets it in.
    await expectDenied(
      act(context, ids.manager, false, "invite_member", {
        organizationId: ids.org, role: "student", token: "a".repeat(24), email: "a@b.co more text after",
      }, "email-anchor-end"),
      400, "validation", "Invalid invitation email.",
    );
  } finally {
    context.database.close();
  }
});

test("OrganizationCommandError carries its own name, not the generic Error name", () => {
  const error = new commands.OrganizationCommandError("test message");
  assert.equal(error.name, "OrganizationCommandError");
  assert.equal(error.status, 400);
  assert.equal(error.code, "validation");
});

test("forbidden() defaults to a fixed message when the caller supplies none", async () => {
  const context = fixture();
  try {
    // invite_member's own forbidden() call always passes a message, so reach
    // the default through a path with no explicit message: a teacher who is
    // neither a manager nor the assigned teacher for this student.
    await expectDenied(
      act(context, ids.teacher2, false, "remove_practice_assignment", {
        organizationId: ids.org, studentUserId: ids.student, assignmentId: "80000000-0000-4000-8000-000000000099",
      }, "forbidden-default"),
      403, "forbidden", "Not permitted.",
    );
  } finally {
    context.database.close();
  }
});

// ---------------------------------------------------------------------------
// id()/text()/optionalText()/bool()/role() (lines 118-155)
// ---------------------------------------------------------------------------

test("id() reports the caller's own label in the validation message", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.owner, false, "request_to_leave", { organizationId: "not-a-uuid" }, "id-label"),
      400, "validation", "Invalid organisation.",
    );
  } finally {
    context.database.close();
  }
});

test("text() requires a string, trims it, and enforces both boundaries with one message", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.owner, false, "create_organization", { organizationName: 42 }, "text-type"),
      400, "validation", "Organisation name is required.",
    );
    await expectDenied(
      act(context, ids.owner, false, "create_organization", { organizationName: "A" }, "text-min"),
      400, "validation", "Invalid organisation name.",
    );
    await expectDenied(
      act(context, ids.owner, false, "create_organization", { organizationName: "x".repeat(121) }, "text-max"),
      400, "validation", "Invalid organisation name.",
    );
    // Exactly the boundary on both sides must be accepted, and the value must
    // actually be trimmed before its length is measured and before storage.
    const short = await act(context, ids.owner, false, "create_organization", { organizationName: "  ab  " }, "text-trim");
    const stored = context.database.prepare("SELECT name FROM organizations WHERE id = ?").get(short.organizationId);
    assert.equal(stored.name, "ab", "surrounding whitespace must be trimmed before storage");
    const long = await act(context, ids.owner, false, "create_organization", { organizationName: "x".repeat(120) }, "text-max-ok");
    assert.equal(long.ok, true, "exactly 120 characters must be accepted");
  } finally {
    context.database.close();
  }
});

test("text()'s bound message lower-cases the label", async () => {
  const context = fixture();
  try {
    // "Confirmation name" -> "confirmation name", not "CONFIRMATION NAME".
    await expectDenied(
      act(context, ids.owner, false, "delete_organization", { organizationId: ids.org, confirmationName: "A" }, "label-lower"),
      400, "validation", "Invalid confirmation name.",
    );
  } finally {
    context.database.close();
  }
});

test("optionalText() treats undefined, explicit null and empty string as absent", async () => {
  const context = fixture();
  try {
    // undefined (key omitted)
    const a = await act(context, ids.student, false, "request_to_leave", { organizationId: ids.org }, "opt-undef");
    assert.equal(a.ok, true);
    // explicit null must not be rejected as "not a string" -- this is the one
    // input that actually distinguishes the `value === null` check from a
    // stubbed-out `false`: without it, optionalText falls through to the
    // typeof guard and throws instead of quietly returning null.
    const context2 = fixture();
    const b = await act(context2, ids.leaveReqStudent, false, "request_access_change", {
      organizationId: ids.org, share: true, scope: "prior", note: null,
    }, "opt-null");
    assert.equal(b.ok, true);
    context2.database.close();
  } finally {
    context.database.close();
  }
});

test("optionalText()'s literal empty-string check is not merely a stand-in for its own trimmed-length fallback", async () => {
  const context = fixture();
  try {
    // Stryker's actual mutant here does not blank out the `value === ""`
    // comparison itself (that one is equivalent -- see the report) but
    // swaps its *string literal* for "Stryker was here!". That is only
    // observable by passing this exact literal as the value: the real
    // check then treats it as ordinary 2000-char-bounded text and keeps
    // it, while the mutant's rewritten comparison matches it and discards
    // it as if it were empty.
    const response = await act(context, ids.student, false, "request_to_leave", {
      organizationId: ids.org, note: "Stryker was here!",
    }, "opt-literal-sentinel");
    assert.equal(response.ok, true);
    const stored = context.database.prepare(
      "SELECT note FROM organization_requests WHERE organization_id = ? AND requester_user_id = ? AND kind = 'leave'",
    ).get(ids.org, ids.student);
    assert.equal(stored.note, "Stryker was here!");
  } finally {
    context.database.close();
  }
});

test("optionalText() rejects a non-string, non-null, non-undefined value", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.student, false, "request_to_leave", { organizationId: ids.org, note: 12345 }, "opt-type"),
      400, "validation", "Invalid text.",
    );
  } finally {
    context.database.close();
  }
});

test("optionalText() enforces its maximum length after trimming", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.student, false, "request_to_leave", { organizationId: ids.org, note: "x".repeat(2001) }, "opt-max"),
      400, "validation", "That text is too long.",
    );
    // note validation runs only after the membership check succeeds, so the
    // failed call above never touched ids.student's row -- reusing it here is
    // safe.
    const ok = await act(context, ids.student, false, "request_to_leave", {
      organizationId: ids.org, note: `  ${"x".repeat(2000)}  `,
    }, "opt-max-ok");
    assert.equal(ok.ok, true, "exactly 2000 characters after trimming must be accepted");
    const stored = context.database.prepare(
      "SELECT note FROM organization_requests WHERE organization_id = ? AND requester_user_id = ? AND kind = 'leave' ORDER BY created_at DESC LIMIT 1",
    ).get(ids.org, ids.student);
    assert.equal(stored.note.length, 2000, "value must be trimmed, not merely bounded before trimming");
  } finally {
    context.database.close();
  }
});

test("bool() only ever returns true for the literal boolean true, defaulting otherwise", async () => {
  const context = fixture();
  try {
    // bool() never throws -- it silently falls back to its default. A
    // truthy-but-not-`true` "approve" must therefore be treated as *false*
    // (reject), not as an error and not as approval. If the BooleanLiteral
    // default were flipped to `true`, this same call would instead approve
    // the request and activate the membership.
    const requestId = await createJoinRequest(context, ids.outsider);
    const response = await act(context, ids.manager, false, "decide_join_request", { requestId, approve: "yes" }, "bool-string");
    assert.equal(response.ok, true);
    assert.equal(membershipRow(context, ids.org, ids.outsider).status, "removed", "a non-boolean approve must be treated as reject, not approve");
  } finally {
    context.database.close();
  }
});

test("role() rejects an unknown role and never defaults allowOwner to true", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "invite_member", {
        organizationId: ids.org, role: "principal", token: "a".repeat(24), userId: ids.outsider,
      }, "role-unknown"),
      400, "validation", "Invalid role.",
    );
    // invite_member calls role(payload.role) with allowOwner left at its
    // default (false); if that default silently became true, "owner" would
    // be accepted as a normal invitation role instead of being rejected here.
    await expectDenied(
      act(context, ids.owner, false, "invite_member", {
        organizationId: ids.org, role: "owner", token: "a".repeat(24), userId: ids.outsider,
      }, "role-owner-not-allowed"),
      400, "validation", "Invalid role.",
    );
  } finally {
    context.database.close();
  }
});

// ---------------------------------------------------------------------------
// canonical()/digest() via idempotency-key replay and conflict (129-169, 316-333)
// ---------------------------------------------------------------------------

test("canonical() actually distinguishes different payloads, so a reused key with different data conflicts", async () => {
  const context = fixture();
  try {
    const key = nextKey("canonical-collision");
    await commands.cloudflareOrganizationCommand(
      context.user(ids.owner), false, "create_organization", { organizationName: "First Name" }, key, context.bindings,
    );
    // Same actor, same idempotency key, a *materially different* payload. If
    // canonical() collapsed every object to the same shape (e.g. the
    // ArrayDeclaration mutant on its map callback), this would hash the same
    // and be silently treated as a duplicate of the first call instead of
    // conflicting.
    await expectDenied(
      commands.cloudflareOrganizationCommand(
        context.user(ids.owner), false, "create_organization", { organizationName: "Second Name" }, key, context.bindings,
      ),
      409, "conflict", "That request identifier was already used with different data.",
    );
  } finally {
    context.database.close();
  }
});

test("priorReceipt's stored-action check is independent of its request-hash check", async () => {
  const context = fixture();
  try {
    // The hash already folds the action in, so an ordinary differing action
    // also changes the hash and is already caught that way (see the test
    // above). The only way to isolate the *action* comparison on its own is
    // to corrupt a receipt's stored action after the fact, leaving its
    // request_hash exactly as a real call with the same payload would still
    // compute it: hash matches, but the two checks are joined with ||, and
    // the stored action alone must still be enough to conflict.
    const key = nextKey("action-mismatch");
    await commands.cloudflareOrganizationCommand(
      context.user(ids.student), false, "request_to_leave", { organizationId: ids.org }, key, context.bindings,
    );
    context.database.prepare(
      "UPDATE organization_command_receipts SET action = 'request_to_join' WHERE idempotency_key = ?",
    ).run(key);
    await expectDenied(
      commands.cloudflareOrganizationCommand(
        context.user(ids.student), false, "request_to_leave", { organizationId: ids.org }, key, context.bindings,
      ),
      409, "conflict", "That request identifier was already used with different data.",
    );
  } finally {
    context.database.close();
  }
});

test("canonical() sorts object keys, so hashing the same request twice does not depend on key insertion order", async () => {
  const context = fixture();
  try {
    // Dropping canonical()'s .sort() call (Stryker's actual MethodExpression
    // mutant here) leaves key order exactly as JSON.stringify sees it, so two
    // deeply-equal payloads that merely spell their keys in a different order
    // would hash differently and be wrongly treated as a data conflict.
    const key = nextKey("canonical-key-order");
    await commands.cloudflareOrganizationCommand(
      context.user(ids.owner), false, "create_organization",
      { organizationName: "Sort Test Co", note: "same content" }, key, context.bindings,
    );
    const replayed = await commands.cloudflareOrganizationCommand(
      context.user(ids.owner), false, "create_organization",
      { note: "same content", organizationName: "Sort Test Co" }, key, context.bindings,
    );
    assert.equal(
      context.database.prepare("SELECT count(*) AS total FROM organizations WHERE name = ?").get("Sort Test Co").total,
      1,
      "a reordered-but-equal payload must replay the cached response, not run the command a second time",
    );
    assert.equal(typeof replayed.organizationId, "string");
  } finally {
    context.database.close();
  }
});

test("replaying the same key with identical data returns the original response without re-running the command", async () => {
  const context = fixture();
  try {
    const key = nextKey("replay-identical");
    const payload = { organizationName: "Replay Co" };
    const first = await commands.cloudflareOrganizationCommand(
      context.user(ids.owner), false, "create_organization", payload, key, context.bindings,
    );
    const second = await commands.cloudflareOrganizationCommand(
      context.user(ids.owner), false, "create_organization", { ...payload }, key, context.bindings,
    );
    assert.deepEqual(second, first, "the exact same response must be replayed");
    assert.equal(
      context.database.prepare("SELECT count(*) AS total FROM organizations WHERE name = ?").get("Replay Co").total,
      1,
      "the organisation must be created only once",
    );
  } finally {
    context.database.close();
  }
});

test("a stale command lock blocks a concurrent command on the same organisation scope", async () => {
  const context = fixture();
  try {
    context.database.prepare(`
      INSERT INTO organization_command_locks (scope_key, owner_key, expires_at, created_at)
      VALUES (?, 'someone-else', ?, ?)
    `).run(`organization:${ids.org}`, FAR_FUTURE, FIXTURE_NOW);
    await expectDenied(
      act(context, ids.manager, false, "request_to_leave", { organizationId: ids.org }, "lock-blocked"),
      409, "conflict", "Another organisation change is still being saved. Try again.",
    );
  } finally {
    context.database.close();
  }
});

test("a request_to_join by code is locked on the organisation it resolves to, not on the actor", async () => {
  const context = fixture();
  try {
    // If commandOrganization's own by-code branch were emptied out, the
    // command's lock scope would fall back to `actor:${user.id}` -- a lock
    // already held on the organisation itself (as a concurrent request from
    // someone else would hold) would then fail to block this call at all.
    // The surrounding whitespace and upper case also matter here in a way
    // they would not for the command's own outcome: request_to_join's *own*
    // body independently re-trims and re-lowercases the same code for its
    // own lookup, so only the lock scope (fed solely by commandOrganization's
    // resolution) can catch a dropped .trim() or a wrong-cased .toUpperCase().
    context.database.prepare(`
      INSERT INTO organization_command_locks (scope_key, owner_key, expires_at, created_at)
      VALUES (?, 'someone-else', ?, ?)
    `).run(`organization:${ids.org}`, FAR_FUTURE, FIXTURE_NOW);
    await expectDenied(
      act(context, ids.outsider, false, "request_to_join", { code: "  ORGJOINCODE1234  ", shareFutureHistoryConsent: true }, "lock-blocked-by-code"),
      409, "conflict", "Another organisation change is still being saved. Try again.",
    );
  } finally {
    context.database.close();
  }
});

test("an expired command lock does not block a new command, and a fresh lock expires roughly 30 seconds out", async () => {
  const context = fixture();
  try {
    context.database.prepare(`
      INSERT INTO organization_command_locks (scope_key, owner_key, expires_at, created_at)
      VALUES (?, 'stale-owner', ?, ?)
    `).run(`organization:${ids.org}`, FAR_PAST, FIXTURE_NOW);
    const response = await act(context, ids.student2, false, "request_access_change", {
      organizationId: ids.org, share: true, scope: "future",
    }, "lock-expired");
    assert.equal(response.ok, true);
    const lockBatch = context.batches.find((batch) =>
      batch.some((statement) => statement.sql.includes("INSERT OR IGNORE INTO organization_command_locks")));
    assert.ok(lockBatch, "the lock acquisition batch must have run");
    const insert = lockBatch.find((statement) => statement.sql.includes("INSERT OR IGNORE INTO organization_command_locks"));
    const expiresAt = insert.values[2];
    // Date.now() + 30_000, not Date.now() - 30_000: a freshly acquired lock
    // must expire in the future, comfortably beyond just a few seconds out.
    assert.ok(
      Date.parse(expiresAt) > Date.now() + 10_000,
      `fresh lock must expire well into the future, got ${expiresAt}`,
    );
  } finally {
    context.database.close();
  }
});

test("acquireLock's optional chaining on the insert result is not a no-op safety net", async () => {
  const context = fixture();
  try {
    // D1's batch() is contractually one result per submitted statement, so
    // result[1] is never actually undefined in production -- but the code
    // still guards it with `?.`, and that guard is only observable by
    // simulating a batch response one element short.
    const realBatch = context.bindings.db.batch.bind(context.bindings.db);
    context.bindings.db.batch = async (statements) => {
      const results = await realBatch(statements);
      const isLockBatch = statements.some((statement) => statement.sql.includes("organization_command_locks"));
      return isLockBatch ? results.slice(0, 1) : results;
    };
    await assert.rejects(
      act(context, ids.student, false, "request_to_leave", { organizationId: ids.org }, "lock-truncated-batch"),
      (error) => {
        // The real code's `?.` turns a missing result[1] into a graceful,
        // typed conflict; dropping it instead lets a raw TypeError escape.
        assert.ok(error instanceof commands.OrganizationCommandError, "must stay a typed command error, not a raw TypeError");
        assert.equal(error.status, 409);
        assert.equal(error.code, "conflict");
        assert.equal(error.message, "Another organisation change is still being saved. Try again.");
        return true;
      },
    );
  } finally {
    context.database.close();
  }
});

test("requireSuccess actually fails the command when a D1 batch reports an unsuccessful result", async () => {
  const context = fixture();
  try {
    // A real D1 binding always resolves batch() (it never reports a false
    // `success` while also resolving, in this test's sqlite-backed stand-in
    // or otherwise) unless something is genuinely wrong -- this simulates
    // that to prove requireSuccess actually looks at it, rather than the
    // command always reporting ok:true regardless of what D1 says.
    const realBatch = context.bindings.db.batch.bind(context.bindings.db);
    context.bindings.db.batch = async (statements) => {
      if (statements.some((statement) => statement.sql.includes("organization_command_locks"))) {
        return realBatch(statements);
      }
      // A mix, not all-false: `.every` correctly fails on this, but a
      // `.some` standing in for it would find the one true result and wave
      // the whole batch through.
      return statements.map((_, index) => ({ success: index !== 0, results: [], meta: {} }));
    };
    await expectDenied(
      act(context, ids.student, false, "request_to_leave", { organizationId: ids.org }, "batch-not-saved"),
      400, "validation", "The organisation change was not saved.",
    );
  } finally {
    context.database.close();
  }
});

async function createJoinRequest(context, requesterId, organizationId = ids.org) {
  await act(context, requesterId, false, "request_to_join", {
    organizationId, shareFutureHistoryConsent: true,
  }, "seed-join-request");
  return context.database.prepare(
    "SELECT id FROM organization_requests WHERE organization_id = ? AND requester_user_id = ? AND kind = 'join' ORDER BY created_at DESC LIMIT 1",
  ).get(organizationId, requesterId).id;
}

// ---------------------------------------------------------------------------
// commandOrganization() (lines 270-294)
// ---------------------------------------------------------------------------

test("commandOrganization resolves the scope from payload.organizationId first, ignoring an unrelated code", async () => {
  const context = fixture();
  try {
    // request_to_join deliberately supplies both -- an id must win over a
    // code that resolves to nothing (an id() check runs first at line 275).
    const response = await act(context, ids.outsider, false, "request_to_join", {
      organizationId: ids.org, code: "does-not-exist", shareFutureHistoryConsent: true,
    }, "resolve-by-id");
    assert.equal(response.ok, true);
  } finally {
    context.database.close();
  }
});

test("commandOrganization resolves a join-by-code request case-insensitively and trims it", async () => {
  const context = fixture();
  try {
    const response = await act(context, ids.outsider, false, "request_to_join", {
      code: "  ORGJOINCODE1234  ", shareFutureHistoryConsent: true,
    }, "resolve-by-code");
    assert.equal(response.ok, true, "the stored join_code is lowercase; the lookup must lower-case and trim the input");
  } finally {
    context.database.close();
  }
});

test("the join-by-code lookup only ever applies to request_to_join, not to an unrelated action carrying a code field", async () => {
  const context = fixture();
  try {
    // decide_join_request has no `code` handling of its own; passing one
    // must not let commandOrganization mistake it for a join-by-code lookup.
    await expectDenied(
      act(context, ids.manager, false, "decide_join_request", { code: "orgjoincode1234", approve: true }, "code-wrong-action"),
      400, "validation", "Invalid request.",
    );
  } finally {
    context.database.close();
  }
});

test("an action's action !== \"request_to_join\" guard is actually load-bearing, not just its typeof payload.code check", async () => {
  const context = fixture();
  try {
    // Both this action's condition being forced to `action === "request_to_join"`
    // and the guard's action name check being widened would only be caught by
    // a case where the code resolves through commandOrganization to a *real
    // but inactive* organisation: only then does the (correctly skipped, for
    // every action but request_to_join) code lookup change what the outer
    // active-organisation guard sees, from "no organisation resolved, guard
    // skipped" to "resolved and refused as inactive" -- a different message
    // than request_to_leave's own missing-organizationId failure.
    context.database.prepare("UPDATE organizations SET join_code = ? WHERE id = ?").run("suspendedcode99", ids.orgSuspended);
    await expectDenied(
      act(context, ids.student, false, "request_to_leave", { code: "suspendedcode99" }, "code-not-request-to-join"),
      400, "validation", "Invalid organisation.",
    );
  } finally {
    context.database.close();
  }
});

test("commandOrganization resolves decide_* and accept_invitation from the request's own organisation, and only those actions", async () => {
  const context = fixture();
  try {
    const requestId = await createJoinRequest(context, ids.outsider);
    // If a suspended *second* organisation's own pending request is decided,
    // the request-id lookup must still find the *right* organisation and the
    // outer active-organisation guard (line 373-379) must then refuse it --
    // proving both the lookup and the guard are wired together correctly.
    context.database.prepare(`
      INSERT INTO organization_requests (id, organization_id, kind, status, requester_user_id, target_user_id, created_at, updated_at)
      VALUES ('90000000-0000-4000-8000-000000000001', ?, 'join', 'pending', ?, ?, ?, ?)
    `).run(ids.orgSuspended, ids.outsider2, ids.outsider2, FIXTURE_NOW, FIXTURE_NOW);
    await expectDenied(
      act(context, ids.manager, false, "decide_join_request", { requestId: "90000000-0000-4000-8000-000000000001", approve: true }, "suspended-org-guard"),
      400, "validation", "Organisation is not active.",
    );
    // The real, active-organisation request must still work normally.
    const response = await act(context, ids.manager, false, "decide_join_request", { requestId, approve: true }, "active-org-ok");
    assert.equal(response.ok, true);
  } finally {
    context.database.close();
  }
});

test("the by-requestId resolution is gated to decide_* and accept_invitation, not to any action carrying a requestId", async () => {
  const context = fixture();
  try {
    // request_to_leave has no use for requestId at all. If the decide_*/
    // accept_invitation name check were widened to always-true, this call
    // would instead resolve commandOrganization's organizationId from the
    // *unrelated* request below (which belongs to the suspended
    // organisation) and get turned away by the outer guard with a different
    // message than request_to_leave's own missing-organizationId failure.
    context.database.prepare(`
      INSERT INTO organization_requests (id, organization_id, kind, status, requester_user_id, target_user_id, created_at, updated_at)
      VALUES ('90000000-0000-4000-8000-000000000004', ?, 'join', 'pending', ?, ?, ?, ?)
    `).run(ids.orgSuspended, ids.outsider2, ids.outsider2, FIXTURE_NOW, FIXTURE_NOW);
    await expectDenied(
      act(context, ids.student, false, "request_to_leave", { requestId: "90000000-0000-4000-8000-000000000004" }, "requestid-wrong-action"),
      400, "validation", "Invalid organisation.",
    );
  } finally {
    context.database.close();
  }
});

// ---------------------------------------------------------------------------
// executeCommand's active-organisation guard and exemptions (373-379)
// ---------------------------------------------------------------------------

test("suspend_organization, restore_organization and delete_organization are exempt from the active-organisation guard", async () => {
  const context = fixture();
  try {
    // orgSuspended is not active; these three actions must still be able to
    // reach their own body rather than being turned away by the generic
    // "Organisation is not active." guard that fires for every other action.
    const restored = await act(context, ids.admin, true, "restore_organization", { organizationId: ids.orgSuspended }, "exempt-restore");
    assert.equal(restored.ok, true);
    const suspended = await act(context, ids.admin, true, "suspend_organization", { organizationId: ids.orgSuspended }, "exempt-suspend");
    assert.equal(suspended.ok, true);
    // delete_organization on the (now suspended again) org must reach its own
    // body too, rather than being stopped by the generic guard.
    await expectDenied(
      act(context, ids.manager, false, "invite_member", {
        organizationId: ids.orgSuspended, role: "student", token: "a".repeat(24), userId: ids.outsider,
      }, "non-exempt-still-guarded"),
      400, "validation", "Organisation is not active.",
    );
  } finally {
    context.database.close();
  }
});

// ---------------------------------------------------------------------------
// create_organization (381-416)
// ---------------------------------------------------------------------------

test("create_organization makes the actor an active owner with future-history sharing on, prior-history off", async () => {
  const context = fixture();
  try {
    const response = await act(context, ids.outsider, false, "create_organization", { organizationName: "New Academy" }, "create-happy");
    assert.equal(response.ok, true);
    assert.equal(typeof response.organizationId, "string");
    const org = context.database.prepare("SELECT status, created_by, join_code FROM organizations WHERE id = ?").get(response.organizationId);
    assert.equal(org.status, "active");
    assert.equal(org.created_by, ids.outsider);
    assert.equal(org.join_code.length, 16, "the join code must be sliced to 16 characters");
    // Exact character set, not merely "no dashes": a UUID's dashes replaced
    // with anything other than "" (e.g. a leftover debug sentinel) would
    // still contain no literal "-" but would fail this.
    assert.match(org.join_code, /^[0-9a-f]{16}$/, "must be exactly 16 lowercase hex characters from the uuid");
    const membership = membershipRow(context, response.organizationId, ids.outsider);
    assert.equal(membership.role, "owner");
    assert.equal(membership.status, "active");
    assert.equal(membership.share_future_history, 1);
    assert.equal(membership.share_pre_join_history, 0);
    const [audit] = auditRows(context, "create_organization").filter((row) => row.organization_id === response.organizationId);
    assert.equal(audit.target_type, "organization");
    assert.equal(audit.target_id, response.organizationId);
  } finally {
    context.database.close();
  }
});

// ---------------------------------------------------------------------------
// suspend_organization / restore_organization (418-432)
// ---------------------------------------------------------------------------

test("suspend_organization and restore_organization require platformAdmin, flip status, and are refused for a non-admin", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.owner, false, "suspend_organization", { organizationId: ids.org }, "suspend-non-admin"),
      403, "forbidden",
    );
    const suspend = await act(context, ids.admin, true, "suspend_organization", { organizationId: ids.org }, "suspend-admin");
    assert.equal(suspend.ok, true);
    assert.equal(context.database.prepare("SELECT status FROM organizations WHERE id = ?").get(ids.org).status, "suspended");
    const [suspendAudit] = auditRows(context, "suspend_organization");
    assert.equal(suspendAudit.target_type, "organization");
    assert.equal(suspendAudit.target_id, ids.org);

    const restore = await act(context, ids.admin, true, "restore_organization", { organizationId: ids.org }, "restore-admin");
    assert.equal(restore.ok, true);
    assert.equal(context.database.prepare("SELECT status FROM organizations WHERE id = ?").get(ids.org).status, "active");
  } finally {
    context.database.close();
  }
});

test("a closed organisation cannot be suspended or restored -- it reads as not found", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.admin, true, "suspend_organization", { organizationId: ids.orgClosed }, "suspend-closed"),
      404, "not_found", "Organisation not found.",
    );
    await expectDenied(
      act(context, ids.admin, true, "restore_organization", { organizationId: ids.orgClosed }, "restore-closed"),
      404, "not_found", "Organisation not found.",
    );
  } finally {
    context.database.close();
  }
});

// ---------------------------------------------------------------------------
// delete_organization (434-478)
// ---------------------------------------------------------------------------

test("delete_organization requires manage rights, exact confirmation text, and removes the row", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.teacher, false, "delete_organization", { organizationId: ids.org, confirmationName: "Harbour Academy" }, "delete-forbidden"),
      403, "forbidden",
    );
    await expectDenied(
      act(context, ids.manager, false, "delete_organization", { organizationId: ids.org, confirmationName: "harbour academy" }, "delete-mismatch"),
      400, "validation", "Type the organisation name exactly to confirm deletion.",
    );
    // Outer whitespace is ignored, but case and spelling are not.
    const response = await act(context, ids.manager, false, "delete_organization", {
      organizationId: ids.org, confirmationName: "  Harbour Academy  ",
    }, "delete-ok");
    assert.equal(response.ok, true);
    assert.equal(context.database.prepare("SELECT count(*) AS total FROM organizations WHERE id = ?").get(ids.org).total, 0);
    const [audit] = auditRows(context, "delete_organization");
    assert.equal(audit.target_type, "organization");
    const metadata = JSON.parse(audit.metadata_json);
    assert.equal(metadata.name, "Harbour Academy");
    assert.equal(metadata.previousStatus, "active");
    assert.equal(metadata.actorRole, "manager");
  } finally {
    context.database.close();
  }
});

test("delete_organization trims the stored organisation name too, not only the confirmation text", async () => {
  const context = fixture();
  try {
    // create_organization always trims before storing, so a name with real
    // surrounding whitespace only occurs for a row that predates that (or
    // was written by some other path) -- simulated directly here.
    context.database.prepare("UPDATE organizations SET name = ? WHERE id = ?").run("  Harbour Academy  ", ids.org);
    const response = await act(context, ids.manager, false, "delete_organization", {
      organizationId: ids.org, confirmationName: "Harbour Academy",
    }, "delete-trims-stored-name");
    assert.equal(response.ok, true);
  } finally {
    context.database.close();
  }
});

test("a manager cannot delete a suspended organisation, but platformAdmin can", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "delete_organization", { organizationId: ids.orgSuspended, confirmationName: "Suspended Academy" }, "delete-suspended-manager"),
      403, "forbidden",
    );
    const response = await act(context, ids.admin, true, "delete_organization", { organizationId: ids.orgSuspended, confirmationName: "Suspended Academy" }, "delete-suspended-admin");
    assert.equal(response.ok, true);
  } finally {
    context.database.close();
  }
});

test("delete_organization reports the platform-admin actor role in its audit metadata when acting with no membership", async () => {
  const context = fixture();
  try {
    const response = await act(context, ids.admin, true, "delete_organization", {
      organizationId: ids.orgClosed === ids.org ? ids.org : ids.orgSuspended, confirmationName: "Suspended Academy",
    }, "delete-audit-admin");
    assert.equal(response.ok, true);
    const metadata = JSON.parse(auditRows(context, "delete_organization")[0].metadata_json);
    assert.equal(metadata.actorRole, "platform_admin");
  } finally {
    context.database.close();
  }
});

test("an organisation that does not exist is refused as not found on delete", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.admin, true, "delete_organization", { organizationId: "11111111-1111-4111-8111-111111111199", confirmationName: "Anything" }, "delete-missing"),
      404, "not_found", "Organisation not found.",
    );
  } finally {
    context.database.close();
  }
});

test("delete_organization's own id() label names the organisation, distinct from the not-found path", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.admin, true, "delete_organization", { organizationId: "not-a-uuid-at-all", confirmationName: "Anything" }, "delete-malformed-id"),
      400, "validation", "Invalid organisation.",
    );
  } finally {
    context.database.close();
  }
});

// ---------------------------------------------------------------------------
// request_to_join (480-530)
// ---------------------------------------------------------------------------

test("request_to_join requires future-history consent before anything else", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.outsider, false, "request_to_join", { organizationId: ids.org, shareFutureHistoryConsent: false }, "join-no-consent"),
      400, "validation", "Future-history consent is required.",
    );
  } finally {
    context.database.close();
  }
});

test("request_to_join's own id() label names the organisation for a malformed id, distinct from a code error", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.outsider, false, "request_to_join", { organizationId: "not-a-uuid", shareFutureHistoryConsent: true }, "join-malformed-id"),
      400, "validation", "Invalid organisation.",
    );
  } finally {
    context.database.close();
  }
});

test("request_to_join resolves by id or by code, and reports the right not-found message for each", async () => {
  const context = fixture();
  try {
    // A syntactically valid but nonexistent organizationId never reaches
    // request_to_join's own "Organisation not found." at all: executeCommand's
    // outer active-organisation guard (which runs first, for every action that
    // isn't suspend/restore/delete_organization) already resolves the same id
    // through the same commandOrganization() call and refuses it as
    // "Organisation is not active." before this action's body ever runs.
    await expectDenied(
      act(context, ids.outsider, false, "request_to_join", {
        organizationId: "11111111-1111-4111-8111-111111111199", shareFutureHistoryConsent: true,
      }, "join-id-missing"),
      400, "validation", "Organisation is not active.",
    );
    await expectDenied(
      act(context, ids.outsider, false, "request_to_join", { code: "no-such-code-here", shareFutureHistoryConsent: true }, "join-code-missing"),
      404, "not_found", "Organisation code not found.",
    );
    // A code must be 8-80 characters.
    await expectDenied(
      act(context, ids.outsider, false, "request_to_join", { code: "short", shareFutureHistoryConsent: true }, "join-code-too-short"),
      400, "validation", "Invalid organisation code.",
    );
  } finally {
    context.database.close();
  }
});

test("request_to_join requires an eligible plan or seat", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.ineligible, false, "request_to_join", { organizationId: ids.org, shareFutureHistoryConsent: true }, "join-ineligible"),
      400, "validation", "A Tracking or AI plan, or an organisation seat, is required to join as a student.",
    );
  } finally {
    context.database.close();
  }
});

test("request_to_join accepts a subscription row still spelled with a retired tier name (LEGACY_TIER_ALIASES)", async () => {
  const context = fixture();
  try {
    // ids.legacyTierOutsider's subscription row reads tier = 'plus', never
    // rewritten since before the tracking/ai rename. It canonicalises to
    // 'ai' (an eligible tier) and must be accepted, not rejected the way a
    // literal SQL tier list that only knows the current names would reject it.
    const response = await act(
      context, ids.legacyTierOutsider, false, "request_to_join",
      { organizationId: ids.org, shareFutureHistoryConsent: true }, "join-legacy-tier",
    );
    assert.equal(response.ok, true);
    const membership = membershipRow(context, ids.org, ids.legacyTierOutsider);
    assert.equal(membership.status, "pending");
  } finally {
    context.database.close();
  }
});

test("request_to_join refuses a pending or otherwise live membership, but allows a fresh request after removal", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.pendingStudent, false, "request_to_join", { organizationId: ids.org, shareFutureHistoryConsent: true }, "join-already-pending"),
      409, "conflict", "Your join request is already awaiting review.",
    );
    await expectDenied(
      act(context, ids.student, false, "request_to_join", { organizationId: ids.org, shareFutureHistoryConsent: true }, "join-already-member"),
      409, "conflict", "You already belong to this organisation.",
    );
    // A previously removed member re-requesting must be allowed, and must
    // update the existing row rather than trying (and failing) to insert a
    // second one for the same (organization_id, user_id) pair.
    const response = await act(context, ids.removedStudent, false, "request_to_join", { organizationId: ids.org, shareFutureHistoryConsent: true }, "join-after-removed");
    assert.equal(response.ok, true);
    const membership = membershipRow(context, ids.org, ids.removedStudent);
    assert.equal(membership.status, "pending");
    assert.equal(membership.role, "student");
    assert.equal(membership.share_future_history, 1);
  } finally {
    context.database.close();
  }
});

test("request_to_join writes the request, notification and audit atomically", async () => {
  const context = fixture();
  try {
    const response = await act(context, ids.outsider, false, "request_to_join", { organizationId: ids.org, shareFutureHistoryConsent: true }, "join-full-effect");
    assert.equal(response.ok, true);
    const request = context.database.prepare(
      "SELECT kind, status, requester_user_id, target_user_id FROM organization_requests WHERE organization_id = ? AND requester_user_id = ?",
    ).get(ids.org, ids.outsider);
    assert.equal(request.kind, "join");
    assert.equal(request.status, "pending");
    assert.equal(request.target_user_id, ids.outsider);
    const notified = context.database.prepare(
      "SELECT count(*) AS total FROM user_notifications WHERE kind = 'organization_request' AND organization_id = ?",
    ).get(ids.org).total;
    assert.ok(notified >= 1, "an owner/manager must be notified of the new join request");
    const [audit] = auditRows(context, "request_to_join");
    assert.equal(audit.target_type, "membership");
  } finally {
    context.database.close();
  }
});

// ---------------------------------------------------------------------------
// decide_join_request / decide_leave_request / decide_access_request (532-604)
// ---------------------------------------------------------------------------

test("deciding a request requires it to exist, be pending, and match the expected kind", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "decide_join_request", { requestId: "90000000-0000-4000-8000-000000000098", approve: true }, "decide-missing"),
      409, "conflict", "Request is no longer awaiting review.",
    );
    const requestId = await createJoinRequest(context, ids.outsider);
    await act(context, ids.manager, false, "decide_join_request", { requestId, approve: true }, "decide-once");
    await expectDenied(
      act(context, ids.manager, false, "decide_join_request", { requestId, approve: true }, "decide-twice"),
      409, "conflict", "Request is no longer awaiting review.",
    );
    const leaveRequestId = await (async () => {
      await act(context, ids.student3, false, "request_to_leave", { organizationId: ids.org }, "decide-kind-seed");
      return context.database.prepare(
        "SELECT id FROM organization_requests WHERE organization_id = ? AND requester_user_id = ? AND kind = 'leave'",
      ).get(ids.org, ids.student3).id;
    })();
    await expectDenied(
      act(context, ids.manager, false, "decide_join_request", { requestId: leaveRequestId, approve: true }, "decide-wrong-kind"),
      400, "validation", "Request type does not match the decision.",
    );
  } finally {
    context.database.close();
  }
});

test("only manage rights, or an assigned teacher for a history-access request, may decide it", async () => {
  const context = fixture();
  try {
    const requestId = await createJoinRequest(context, ids.outsider);
    await expectDenied(
      act(context, ids.teacher, false, "decide_join_request", { requestId, approve: true }, "decide-teacher-not-allowed-for-join"),
      403, "forbidden",
    );
    // history_access_change: the *assigned* teacher may decide it...
    await act(context, ids.student, false, "request_access_change", { organizationId: ids.org, share: false, scope: "prior" }, "history-seed-1");
    const historyRequestId = context.database.prepare(
      "SELECT id FROM organization_requests WHERE organization_id = ? AND requester_user_id = ? AND kind = 'history_access_change'",
    ).get(ids.org, ids.student).id;
    const decided = await act(context, ids.teacher, false, "decide_access_request", { requestId: historyRequestId, approve: true }, "decide-history-assigned-teacher");
    assert.equal(decided.ok, true);
    // ...but an unassigned teacher may not.
    await act(context, ids.student2, false, "request_access_change", { organizationId: ids.org, share: false, scope: "prior" }, "history-seed-2");
    const secondRequestId = context.database.prepare(
      "SELECT id FROM organization_requests WHERE organization_id = ? AND requester_user_id = ? AND kind = 'history_access_change'",
    ).get(ids.org, ids.student2).id;
    await expectDenied(
      act(context, ids.teacher2, false, "decide_access_request", { requestId: secondRequestId, approve: true }, "decide-history-unassigned-teacher"),
      403, "forbidden",
    );
  } finally {
    context.database.close();
  }
});

test("the assigned-teacher allowance is scoped to history-access requests specifically, even for join/leave requests from that same assigned student", async () => {
  const context = fixture();
  try {
    // ids.student is the one student ids.teacher is actually assigned to in
    // the base fixture -- using it here (rather than an unrelated requester)
    // is what actually distinguishes "gated to history_access_change" from
    // "gated to assigned() returning true for any request kind".
    await act(context, ids.student, false, "request_to_leave", { organizationId: ids.org }, "leave-seed-scope-check");
    const leaveRequestId = context.database.prepare(
      "SELECT id FROM organization_requests WHERE organization_id = ? AND requester_user_id = ? AND kind = 'leave'",
    ).get(ids.org, ids.student).id;
    await expectDenied(
      act(context, ids.teacher, false, "decide_leave_request", { requestId: leaveRequestId, approve: true }, "decide-leave-by-assigned-teacher-forbidden"),
      403, "forbidden",
    );
  } finally {
    context.database.close();
  }
});

test("the assigned-teacher allowance genuinely requires the actor's role to be teacher, not merely a row in teacher_student_assignments", async () => {
  const context = fixture();
  try {
    // A non-teacher (role student) actor manually given an assignment row --
    // an anomaly the normal command flow does not produce (change_member_role
    // revokes these when a teacher's role changes away from teacher), but
    // exactly what's needed to isolate this actorRole check from canManage,
    // which a manager or owner would already satisfy on its own.
    context.database.prepare(`
      INSERT INTO teacher_student_assignments (id, organization_id, teacher_user_id, student_user_id, assigned_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("72000000-0000-4000-8000-000000000002", ids.org, ids.student2, ids.student3, ids.manager, FIXTURE_NOW);
    await act(context, ids.student3, false, "request_access_change", { organizationId: ids.org, share: false, scope: "prior" }, "history-non-teacher-actor-seed");
    const requestId = context.database.prepare(
      "SELECT id FROM organization_requests WHERE organization_id = ? AND requester_user_id = ? AND kind = 'history_access_change'",
    ).get(ids.org, ids.student3).id;
    await expectDenied(
      act(context, ids.student2, false, "decide_access_request", { requestId, approve: true }, "decide-history-non-teacher-actor-forbidden"),
      403, "forbidden",
    );
  } finally {
    context.database.close();
  }
});

test("approving a join request re-checks eligibility and refuses if it has lapsed", async () => {
  const context = fixture();
  try {
    // Hand-inserted directly: the eligibility re-check at decision time is
    // independent of whatever eligibility existed (or didn't) when the
    // request was first filed.
    context.database.prepare(`
      INSERT INTO organization_requests (id, organization_id, kind, status, requester_user_id, target_user_id, created_at, updated_at)
      VALUES ('90000000-0000-4000-8000-000000000002', ?, 'join', 'pending', ?, ?, ?, ?)
    `).run(ids.org, ids.ineligible, ids.ineligible, FIXTURE_NOW, FIXTURE_NOW);
    await expectDenied(
      act(context, ids.manager, false, "decide_join_request", { requestId: "90000000-0000-4000-8000-000000000002", approve: true }, "decide-join-ineligible"),
      400, "validation", "The student no longer has an eligible plan or seat.",
    );
    // Rejecting the same request needs no eligibility at all.
    const rejected = await act(context, ids.manager, false, "decide_join_request", { requestId: "90000000-0000-4000-8000-000000000002", approve: false }, "decide-join-ineligible-reject");
    assert.equal(rejected.ok, true);
  } finally {
    context.database.close();
  }
});

test("approving a leave or history-access request never re-checks student eligibility -- only approving a join request does", async () => {
  const context = fixture();
  try {
    // ids.student3 loses eligibility (unlike ids.student2, it holds no seat
    // allocation anywhere in the fixture, so removing its subscription
    // actually removes eligibility), then still requests to leave (that
    // request has no eligibility gate of its own) -- approving the leave
    // must not incorrectly reuse the join-approval eligibility re-check.
    context.database.prepare("DELETE FROM subscriptions WHERE user_id = ?").run(ids.student3);
    await act(context, ids.student3, false, "request_to_leave", { organizationId: ids.org }, "leave-ineligible-seed");
    const requestId = context.database.prepare(
      "SELECT id FROM organization_requests WHERE organization_id = ? AND requester_user_id = ? AND kind = 'leave'",
    ).get(ids.org, ids.student3).id;
    const approved = await act(context, ids.manager, false, "decide_leave_request", { requestId, approve: true }, "decide-leave-ineligible-ok");
    assert.equal(approved.ok, true);
  } finally {
    context.database.close();
  }
});

test("approving a join request activates the membership and sets joined_at; rejecting removes it", async () => {
  const context = fixture();
  try {
    const approvedRequestId = await createJoinRequest(context, ids.outsider);
    const approved = await act(context, ids.manager, false, "decide_join_request", { requestId: approvedRequestId, approve: true }, "decide-join-approve");
    assert.equal(approved.ok, true);
    const approvedMembership = membershipRow(context, ids.org, ids.outsider);
    assert.equal(approvedMembership.status, "active");
    assert.ok(approvedMembership.joined_at, "joined_at must be set on approval");

    const rejectedRequestId = await createJoinRequest(context, ids.outsider2);
    const rejected = await act(context, ids.manager, false, "decide_join_request", { requestId: rejectedRequestId, approve: false }, "decide-join-reject");
    assert.equal(rejected.ok, true);
    assert.equal(membershipRow(context, ids.org, ids.outsider2).status, "removed");
    const [audit] = auditRows(context, "decide_join_request").filter((row) => row.target_id === rejectedRequestId);
    assert.equal(audit.target_type, "request");
    assert.equal(JSON.parse(audit.metadata_json).approved, false);
  } finally {
    context.database.close();
  }
});

test("approving a leave request removes the membership and revokes the student's teacher assignments; rejecting restores it", async () => {
  const context = fixture();
  try {
    // ids.leaveReqStudent already carries status leave_requested in the base
    // fixture (needed elsewhere); request_to_leave itself requires an
    // *active* membership, so this needs a still-active student instead.
    await act(context, ids.student2, false, "request_to_leave", { organizationId: ids.org }, "leave-seed");
    // Give the leaving student an active teacher assignment to revoke.
    await act(context, ids.manager, false, "assign_teacher", {
      organizationId: ids.org, teacherUserId: ids.teacher2, studentUserId: ids.student2,
    }, "leave-assign-teacher");
    const requestId = context.database.prepare(
      "SELECT id FROM organization_requests WHERE organization_id = ? AND requester_user_id = ? AND kind = 'leave'",
    ).get(ids.org, ids.student2).id;
    const approved = await act(context, ids.manager, false, "decide_leave_request", { requestId, approve: true }, "decide-leave-approve");
    assert.equal(approved.ok, true);
    const membership = membershipRow(context, ids.org, ids.student2);
    assert.equal(membership.status, "removed");
    assert.ok(membership.removed_at);
    const assignment = context.database.prepare(
      "SELECT revoked_at FROM teacher_student_assignments WHERE organization_id = ? AND teacher_user_id = ? AND student_user_id = ?",
    ).get(ids.org, ids.teacher2, ids.student2);
    assert.ok(assignment.revoked_at, "leaving must revoke the teacher assignment");

    // Reject path, on a fresh leave request. Also carrying a teacher
    // assignment of its own, so a rejected leave can be shown to leave it
    // alone -- only an *approved* leave may revoke it.
    await act(context, ids.manager, false, "assign_teacher", {
      organizationId: ids.org, teacherUserId: ids.teacher, studentUserId: ids.student3,
    }, "leave-reject-assign-teacher");
    await act(context, ids.student3, false, "request_to_leave", { organizationId: ids.org }, "leave-seed-reject");
    const rejectId = context.database.prepare(
      "SELECT id FROM organization_requests WHERE organization_id = ? AND requester_user_id = ? AND kind = 'leave'",
    ).get(ids.org, ids.student3).id;
    const rejected = await act(context, ids.manager, false, "decide_leave_request", { requestId: rejectId, approve: false }, "decide-leave-reject");
    assert.equal(rejected.ok, true);
    assert.equal(membershipRow(context, ids.org, ids.student3).status, "active");
    assert.equal(
      context.database.prepare(
        "SELECT revoked_at FROM teacher_student_assignments WHERE organization_id = ? AND teacher_user_id = ? AND student_user_id = ?",
      ).get(ids.org, ids.teacher, ids.student3).revoked_at,
      null,
      "rejecting a leave must not revoke the student's teacher assignment",
    );
  } finally {
    context.database.close();
  }
});

test("deciding a future-scope history request writes share_future_history; a prior-scope request writes share_pre_join_history", async () => {
  const context = fixture();
  try {
    await act(context, ids.student, false, "request_access_change", { organizationId: ids.org, share: false, scope: "future" }, "history-future-seed");
    const futureRequestId = context.database.prepare(
      "SELECT id FROM organization_requests WHERE organization_id = ? AND requester_user_id = ? AND kind = 'history_access_change' ORDER BY created_at DESC LIMIT 1",
    ).get(ids.org, ids.student).id;
    await act(context, ids.manager, false, "decide_access_request", { requestId: futureRequestId, approve: true }, "history-future-decide");
    assert.equal(membershipRow(context, ids.org, ids.student).share_future_history, 0);

    // requested_value=1 specifically: `?? 0` and `&& 0` only disagree on a
    // truthy requested_value (1), not on 0, so the false-share case above
    // alone would not catch a dropped `??`.
    await act(context, ids.student3, false, "request_access_change", { organizationId: ids.org, share: true, scope: "future" }, "history-future-seed-true");
    const futureTrueRequestId = context.database.prepare(
      "SELECT id FROM organization_requests WHERE organization_id = ? AND requester_user_id = ? AND kind = 'history_access_change' ORDER BY created_at DESC LIMIT 1",
    ).get(ids.org, ids.student3).id;
    await act(context, ids.manager, false, "decide_access_request", { requestId: futureTrueRequestId, approve: true }, "history-future-decide-true");
    assert.equal(membershipRow(context, ids.org, ids.student3).share_future_history, 1);

    await act(context, ids.student2, false, "request_access_change", { organizationId: ids.org, share: true, scope: "prior" }, "history-prior-seed");
    const priorRequestId = context.database.prepare(
      "SELECT id FROM organization_requests WHERE organization_id = ? AND requester_user_id = ? AND kind = 'history_access_change' ORDER BY created_at DESC LIMIT 1",
    ).get(ids.org, ids.student2).id;
    await act(context, ids.manager, false, "decide_access_request", { requestId: priorRequestId, approve: true }, "history-prior-decide");
    assert.equal(membershipRow(context, ids.org, ids.student2).share_pre_join_history, 1);

    // Rejecting either scope must leave the sharing flag untouched -- the
    // write statement is gated on `approve`, not unconditional once the
    // scope is decided.
    await act(context, ids.leaveReqStudent, false, "request_access_change", { organizationId: ids.org, share: true, scope: "prior" }, "history-prior-seed-reject");
    const priorRejectId = context.database.prepare(
      "SELECT id FROM organization_requests WHERE organization_id = ? AND requester_user_id = ? AND kind = 'history_access_change' ORDER BY created_at DESC LIMIT 1",
    ).get(ids.org, ids.leaveReqStudent).id;
    await act(context, ids.manager, false, "decide_access_request", { requestId: priorRejectId, approve: false }, "history-prior-decide-reject");
    assert.equal(membershipRow(context, ids.org, ids.leaveReqStudent).share_pre_join_history, 0);
  } finally {
    context.database.close();
  }
});

// ---------------------------------------------------------------------------
// request_to_leave (606-631)
// ---------------------------------------------------------------------------

test("request_to_leave requires an active student membership", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.teacher, false, "request_to_leave", { organizationId: ids.org }, "leave-not-student"),
      400, "validation", "No active student membership.",
    );
    await expectDenied(
      act(context, ids.leaveReqStudent, false, "request_to_leave", { organizationId: ids.org }, "leave-already-requested"),
      400, "validation", "No active student membership.",
    );
  } finally {
    context.database.close();
  }
});

test("request_to_leave writes a pending leave request, flips the membership, notifies and audits", async () => {
  const context = fixture();
  try {
    const response = await act(context, ids.student, false, "request_to_leave", { organizationId: ids.org, note: "moving on" }, "leave-effect");
    assert.equal(response.ok, true);
    const request = context.database.prepare(
      "SELECT kind, status, note FROM organization_requests WHERE organization_id = ? AND requester_user_id = ?",
    ).get(ids.org, ids.student);
    assert.equal(request.kind, "leave");
    assert.equal(request.status, "pending");
    assert.equal(request.note, "moving on");
    assert.equal(membershipRow(context, ids.org, ids.student).status, "leave_requested");
    const [audit] = auditRows(context, "request_to_leave");
    assert.equal(audit.target_type, "membership");
  } finally {
    context.database.close();
  }
});

// ---------------------------------------------------------------------------
// request_access_change / set_prior_history_sharing (633-686)
// ---------------------------------------------------------------------------

test("history-sharing changes require a student membership", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.teacher, false, "request_access_change", { organizationId: ids.org, share: true, scope: "prior" }, "history-not-student"),
      400, "validation", "No student membership.",
    );
  } finally {
    context.database.close();
  }
});

test("request_access_change's own id() label names the organisation for a malformed id", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.student, false, "request_access_change", { organizationId: "not-a-uuid", share: true, scope: "prior" }, "history-malformed-id"),
      400, "validation", "Invalid organisation.",
    );
  } finally {
    context.database.close();
  }
});

test("a former student may write share_pre_join_history directly, with no approval step, only for the prior scope", async () => {
  const context = fixture();
  try {
    const response = await act(context, ids.removedStudent, false, "set_prior_history_sharing", {
      organizationId: ids.org, share: false, scope: "prior",
    }, "history-direct-after-leaving");
    assert.equal(response.ok, true);
    assert.equal(membershipRow(context, ids.org, ids.removedStudent).share_pre_join_history, 0);
    assert.equal(
      context.database.prepare(
        "SELECT count(*) AS total FROM organization_requests WHERE organization_id = ? AND requester_user_id = ? AND kind = 'history_access_change'",
      ).get(ids.org, ids.removedStudent).total,
      0,
      "no approval request may be created for this direct path",
    );
    const [audit] = auditRows(context, "set_prior_history_sharing");
    assert.equal(audit.target_type, "membership");
    assert.equal(JSON.parse(audit.metadata_json).directAfterLeaving, true);
  } finally {
    context.database.close();
  }
});

test("a still-active student calling set_prior_history_sharing still goes through the normal approval request, not the direct-write path", async () => {
  const context = fixture();
  try {
    // The direct-write path is gated on membership.status === "removed"; an
    // active member's call must fall through to the ordinary pending-request
    // flow instead, leaving share_pre_join_history untouched until approved.
    const response = await act(context, ids.student, false, "set_prior_history_sharing", {
      organizationId: ids.org, share: true, scope: "prior",
    }, "history-direct-active-not-removed");
    assert.equal(response.ok, true);
    assert.equal(membershipRow(context, ids.org, ids.student).share_pre_join_history, 0);
    assert.equal(
      context.database.prepare(
        "SELECT count(*) AS total FROM organization_requests WHERE organization_id = ? AND requester_user_id = ? AND kind = 'history_access_change'",
      ).get(ids.org, ids.student).total,
      1,
      "an active member's request must go through the pending approval flow",
    );
  } finally {
    context.database.close();
  }
});

test("a former student's *future*-scope change is not the direct path, and request_access_change is not the direct path either", async () => {
  const context = fixture();
  try {
    // Wrong action name for the removed-member direct path.
    await expectDenied(
      act(context, ids.removedStudent, false, "request_access_change", { organizationId: ids.org, share: true, scope: "prior" }, "history-removed-wrong-action"),
      400, "validation", "No active student membership.",
    );
    // Wrong scope for the removed-member direct path -- future scope for a
    // removed member has no direct control, and is refused like any other
    // non-active-non-leave-requested membership.
    await expectDenied(
      act(context, ids.removedStudent, false, "set_prior_history_sharing", { organizationId: ids.org, share: true, scope: "future" }, "history-removed-wrong-scope"),
      400, "validation", "No active student membership.",
    );
  } finally {
    context.database.close();
  }
});

test("an active or leave-requested student may file a history-access request; anyone else is refused", async () => {
  const context = fixture();
  try {
    const active = await act(context, ids.student, false, "request_access_change", { organizationId: ids.org, share: false, scope: "prior" }, "history-active-ok");
    assert.equal(active.ok, true);
    const leaveRequested = await act(context, ids.leaveReqStudent, false, "request_access_change", { organizationId: ids.org, share: true, scope: "future" }, "history-leave-requested-ok");
    assert.equal(leaveRequested.ok, true);
    await expectDenied(
      act(context, ids.suspendedStudent, false, "request_access_change", { organizationId: ids.org, share: true, scope: "prior" }, "history-suspended-refused"),
      400, "validation", "No active student membership.",
    );
  } finally {
    context.database.close();
  }
});

test("a history-access request encodes future scope as a note and prior scope with the caller's own note", async () => {
  const context = fixture();
  try {
    await act(context, ids.student, false, "request_access_change", { organizationId: ids.org, share: true, scope: "future" }, "history-note-future");
    const futureNote = context.database.prepare(
      "SELECT note, requested_value FROM organization_requests WHERE organization_id = ? AND requester_user_id = ? AND kind = 'history_access_change' ORDER BY created_at DESC LIMIT 1",
    ).get(ids.org, ids.student);
    assert.equal(futureNote.note, "scope:future");
    assert.equal(futureNote.requested_value, 1);
    const [audit] = auditRows(context, "request_access_change");
    assert.equal(audit.target_type, "membership");
    const auditMetadata = JSON.parse(audit.metadata_json);
    assert.equal(auditMetadata.requestedValue, true);
    assert.equal(auditMetadata.historyScope, "future");

    await act(context, ids.student2, false, "request_access_change", { organizationId: ids.org, share: false, scope: "prior", note: "please review" }, "history-note-prior");
    const priorNote = context.database.prepare(
      "SELECT note, requested_value FROM organization_requests WHERE organization_id = ? AND requester_user_id = ? AND kind = 'history_access_change' ORDER BY created_at DESC LIMIT 1",
    ).get(ids.org, ids.student2);
    assert.equal(priorNote.note, "please review");
    assert.equal(priorNote.requested_value, 0);
  } finally {
    context.database.close();
  }
});

// ---------------------------------------------------------------------------
// invite_member (688-769)
// ---------------------------------------------------------------------------

test("invite_member's own id() label names the organisation for a malformed id", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "invite_member", { organizationId: "not-a-uuid", role: "student", token: "a".repeat(24), userId: ids.outsider }, "invite-malformed-org-id"),
      400, "validation", "Invalid organisation.",
    );
  } finally {
    context.database.close();
  }
});

test("invite_member requires manage rights, unless the actor is a teacher inviting by account id", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.student, false, "invite_member", { organizationId: ids.org, role: "student", token: "a".repeat(24), userId: ids.outsider }, "invite-forbidden"),
      403, "forbidden",
    );
    // A teacher inviting *by account id* is allowed...
    const byAccount = await act(context, ids.teacher, false, "invite_member", {
      organizationId: ids.org, role: "student", token: "a".repeat(24), userId: ids.outsider,
    }, "invite-teacher-by-account");
    assert.equal(byAccount.ok, true);
    // ...but a teacher inviting *by email* (no userId) is not.
    await expectDenied(
      act(context, ids.teacher, false, "invite_member", { organizationId: ids.org, role: "student", token: "a".repeat(24), email: "someone@example.com" }, "invite-teacher-by-email-refused"),
      403, "forbidden",
    );
  } finally {
    context.database.close();
  }
});

test("a teacher may only invite students, never teachers or managers", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.teacher, false, "invite_member", { organizationId: ids.org, role: "teacher", token: "a".repeat(24), userId: ids.outsider }, "invite-teacher-invites-teacher"),
      403, "forbidden", "Teachers can invite students only.",
    );
  } finally {
    context.database.close();
  }
});

test("only an owner or platformAdmin may invite a manager", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "invite_member", { organizationId: ids.org, role: "manager", token: "a".repeat(24), userId: ids.outsider }, "invite-manager-by-manager"),
      400, "validation", "Only an owner can invite a manager.",
    );
    const byOwner = await act(context, ids.owner, false, "invite_member", { organizationId: ids.org, role: "manager", token: "a".repeat(24), userId: ids.outsider }, "invite-manager-by-owner");
    assert.equal(byOwner.ok, true);
    const byAdmin = await act(context, ids.admin, true, "invite_member", { organizationId: ids.org, role: "manager", token: "b".repeat(24), userId: ids.outsider2 }, "invite-manager-by-admin");
    assert.equal(byAdmin.ok, true);
  } finally {
    context.database.close();
  }
});

test("an invitation token must be 24-512 characters", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "invite_member", { organizationId: ids.org, role: "student", token: "a".repeat(23), userId: ids.outsider }, "invite-token-short"),
      400, "validation", "Invalid invitation token.",
    );
    const ok = await act(context, ids.manager, false, "invite_member", { organizationId: ids.org, role: "student", token: "a".repeat(24), userId: ids.outsider }, "invite-token-boundary");
    assert.equal(ok.ok, true);
  } finally {
    context.database.close();
  }
});

test("invite_member requires an account id or an email, not both, and finds an unknown account id", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "invite_member", {
        organizationId: ids.org, role: "student", token: "a".repeat(24), userId: "11111111-1111-4111-8111-111111111188",
      }, "invite-account-missing"),
      404, "not_found", "Account not found.",
    );
    await expectDenied(
      act(context, ids.manager, false, "invite_member", {
        organizationId: ids.org, role: "student", token: "a".repeat(24), userId: "not-a-uuid",
      }, "invite-account-malformed"),
      400, "validation", "Invalid account.",
    );
    // Below text()'s own 3-character minimum -- distinct from the EMAIL
    // regex check further down, and carries its own label in the message.
    await expectDenied(
      act(context, ids.manager, false, "invite_member", {
        organizationId: ids.org, role: "student", token: "a".repeat(24), email: "ab",
      }, "invite-email-too-short"),
      400, "validation", "Invalid invitation email.",
    );
  } finally {
    context.database.close();
  }
});

test("invite_member requires eligibility for a student invitation targeting a known account", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "invite_member", { organizationId: ids.org, role: "student", token: "a".repeat(24), userId: ids.ineligible }, "invite-ineligible-account"),
      400, "validation", "The student needs an eligible plan or seat.",
    );
    // A teacher invitation is never gated on student eligibility.
    const teacherInvite = await act(context, ids.manager, false, "invite_member", {
      organizationId: ids.org, role: "teacher", token: "a".repeat(24), userId: ids.ineligible,
    }, "invite-ineligible-as-teacher");
    assert.equal(teacherInvite.ok, true);
  } finally {
    context.database.close();
  }
});

test("invite_member refuses a target who already has a live membership, but allows re-inviting a removed one", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "invite_member", { organizationId: ids.org, role: "student", token: "a".repeat(24), userId: ids.student2 }, "invite-already-member"),
      409, "conflict", "That person already has a membership in this organisation.",
    );
    const response = await act(context, ids.manager, false, "invite_member", { organizationId: ids.org, role: "student", token: "a".repeat(24), userId: ids.removedStudent }, "invite-removed-again");
    assert.equal(response.ok, true);
  } finally {
    context.database.close();
  }
});

test("invite_member refuses a second pending invitation for the same target account or email", async () => {
  const context = fixture();
  try {
    await act(context, ids.manager, false, "invite_member", { organizationId: ids.org, role: "student", token: "a".repeat(24), userId: ids.outsider }, "invite-dup-account-first");
    await expectDenied(
      act(context, ids.manager, false, "invite_member", { organizationId: ids.org, role: "teacher", token: "b".repeat(24), userId: ids.outsider }, "invite-dup-account-second"),
      409, "conflict", "An invitation for that account is already awaiting a response.",
    );
    await act(context, ids.manager, false, "invite_member", { organizationId: ids.org, role: "student", token: "a".repeat(24), email: "invitee@example.com" }, "invite-dup-email-first");
    await expectDenied(
      act(context, ids.manager, false, "invite_member", { organizationId: ids.org, role: "teacher", token: "b".repeat(24), email: "INVITEE@EXAMPLE.COM" }, "invite-dup-email-second"),
      409, "conflict", "An invitation for that account is already awaiting a response.",
    );
  } finally {
    context.database.close();
  }
});

test("invite_member notifies an account-bound invitee but not an email-only one, and audits the requested role", async () => {
  const context = fixture();
  try {
    const accountInvite = await act(context, ids.manager, false, "invite_member", { organizationId: ids.org, role: "teacher", token: "a".repeat(24), userId: ids.outsider }, "invite-notify-account");
    assert.equal(
      context.database.prepare(
        "SELECT count(*) AS total FROM user_notifications WHERE kind = 'organization_invitation' AND recipient_user_id = ?",
      ).get(ids.outsider).total,
      1,
    );
    const [audit] = auditRows(context, "invite_member").filter((row) => row.target_id === accountInvite.invitation.requestId);
    assert.equal(audit.target_type, "request");
    assert.equal(JSON.parse(audit.metadata_json).role, "teacher");

    await act(context, ids.manager, false, "invite_member", { organizationId: ids.org, role: "student", token: "a".repeat(24), email: "email-only@example.com" }, "invite-notify-email");
    assert.equal(
      context.database.prepare("SELECT count(*) AS total FROM user_notifications WHERE kind = 'organization_invitation'").get().total,
      1,
      "an email-only invitation must not create an in-app notification",
    );
  } finally {
    context.database.close();
  }
});

// ---------------------------------------------------------------------------
// accept_invitation (771-839)
// ---------------------------------------------------------------------------

async function invite(context, actorId, overrides) {
  const response = await act(context, actorId, false, "invite_member", {
    organizationId: ids.org, role: "student", token: "a".repeat(24), ...overrides,
  }, "invite-for-accept");
  return response.invitation.requestId;
}

// Mirrors digest()/sha256() in organization-commands.ts/payloads.ts exactly
// for a plain string token: canonical(string) is a no-op, so this is just
// sha256(JSON.stringify(token)). invite_member itself enforces a 24-character
// floor on the token it is handed, so a request with a *shorter* token hash
// can only be produced by inserting the row directly, as below.
async function tokenHash(token) {
  const bytes = new TextEncoder().encode(JSON.stringify(token));
  const digestBuffer = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digestBuffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("accept_invitation requires future-history consent", async () => {
  const context = fixture();
  try {
    const requestId = await invite(context, ids.manager, { userId: ids.outsider });
    await expectDenied(
      act(context, ids.outsider, false, "accept_invitation", { requestId, shareFutureHistoryConsent: false }, "accept-no-consent"),
      400, "validation", "Future-history consent is required.",
    );
    await expectDenied(
      act(context, ids.outsider, false, "accept_invitation", { requestId: "not-a-uuid", shareFutureHistoryConsent: true }, "accept-malformed-request-id"),
      400, "validation", "Invalid request.",
    );
  } finally {
    context.database.close();
  }
});

test("accepting an invitation into a since-suspended organisation is refused, not silently allowed", async () => {
  const context = fixture();
  try {
    // accept_invitation's own body never checks the organisation's status
    // directly -- that is entirely the outer active-organisation guard's
    // job, which resolves the organisation via this same pending request.
    // If accept_invitation were dropped from that resolution, this
    // membership would be created in a suspended organisation.
    const requestId = await invite(context, ids.manager, { userId: ids.outsider });
    await act(context, ids.admin, true, "suspend_organization", { organizationId: ids.org }, "accept-then-suspend");
    await expectDenied(
      act(context, ids.outsider, false, "accept_invitation", { requestId, shareFutureHistoryConsent: true }, "accept-suspended-org"),
      400, "validation", "Organisation is not active.",
    );
  } finally {
    context.database.close();
  }
});

test("an account-bound invitation is accepted by the target account with no token", async () => {
  const context = fixture();
  try {
    const requestId = await invite(context, ids.manager, { userId: ids.outsider });
    const response = await act(context, ids.outsider, false, "accept_invitation", { requestId, shareFutureHistoryConsent: true }, "accept-account-bound");
    assert.equal(response.ok, true);
    assert.equal(membershipRow(context, ids.org, ids.outsider).status, "active");
    const [audit] = auditRows(context, "accept_invitation");
    assert.equal(audit.target_type, "request");
  } finally {
    context.database.close();
  }
});

test("an already-decided invitation cannot be accepted a second time", async () => {
  const context = fixture();
  try {
    const requestId = await invite(context, ids.manager, { userId: ids.outsider2 });
    const first = await act(context, ids.outsider2, false, "accept_invitation", { requestId, shareFutureHistoryConsent: true }, "accept-already-decided-first");
    assert.equal(first.ok, true);
    // Distinguishing this from "not pending" reaching some *other* later
    // check (like the already-active-membership one) matters: they throw
    // different messages, and only the earlier, status-specific guard is
    // under test here.
    await expectDenied(
      act(context, ids.outsider2, false, "accept_invitation", { requestId, shareFutureHistoryConsent: true }, "accept-already-decided-second"),
      404, "not_found", "Invitation not found.",
    );
  } finally {
    context.database.close();
  }
});

test("accept_invitation refuses a non-invitation request even when it would otherwise satisfy every other check", async () => {
  const context = fixture();
  try {
    // A real join/leave/history_access_change row is never accountBound in
    // practice (its own target_user_id is its own requester, it never
    // carries an expires_at, and it never carries a requested_role) --
    // this is hand-built with all three set anyway, specifically to isolate
    // the kind check from those other, always-coincident guards: without it,
    // this row would otherwise sail all the way through to actually
    // creating a membership from what is really just a join request.
    const requestId = "90000000-0000-4000-8000-000000000006";
    context.database.prepare(`
      INSERT INTO organization_requests (id, organization_id, kind, status, requester_user_id, target_user_id, requested_role, expires_at, created_at, updated_at)
      VALUES (?, ?, 'join', 'pending', ?, ?, 'student', ?, ?, ?)
    `).run(requestId, ids.org, ids.outsider2, ids.outsider2, FAR_FUTURE, FIXTURE_NOW, FIXTURE_NOW);
    await expectDenied(
      act(context, ids.outsider2, false, "accept_invitation", { requestId, shareFutureHistoryConsent: true }, "accept-non-invitation-kind"),
      404, "not_found", "Invitation not found.",
    );
    assert.equal(
      context.database.prepare("SELECT count(*) AS total FROM organization_memberships WHERE organization_id = ? AND user_id = ?").get(ids.org, ids.outsider2).total,
      0,
      "no membership may be created from a non-invitation request",
    );
  } finally {
    context.database.close();
  }
});

test("an account-bound invitation is refused for anyone other than its target", async () => {
  const context = fixture();
  try {
    const requestId = await invite(context, ids.manager, { userId: ids.outsider });
    await expectDenied(
      act(context, ids.outsider2, false, "accept_invitation", { requestId, shareFutureHistoryConsent: true }, "accept-wrong-account"),
      404, "not_found", "Invitation not found.",
    );
    // Even armed with the correct token, a different account must not be
    // able to redeem an invitation bound to somebody else's account --
    // secretBound's own target_user_id check is what stops this, separately
    // from accountBound's (which the plain no-token case above already
    // exercises).
    await expectDenied(
      act(context, ids.outsider2, false, "accept_invitation", { requestId, token: "a".repeat(24), shareFutureHistoryConsent: true }, "accept-wrong-account-with-token"),
      404, "not_found", "Invitation not found.",
    );
  } finally {
    context.database.close();
  }
});

test("an email invitation is refused with no token, even for the invited address", async () => {
  const context = fixture();
  try {
    const requestId = await invite(context, ids.manager, { email: `${ids.outsider}@example.com` });
    await expectDenied(
      act(context, ids.outsider, false, "accept_invitation", { requestId, shareFutureHistoryConsent: true }, "accept-email-no-token"),
      404, "not_found", "Invitation not found.",
    );
  } finally {
    context.database.close();
  }
});

test("a genuinely unresolved email invitation (target_user_id truly null) is still accepted via secretBound's own null check", async () => {
  const context = fixture();
  try {
    // Every seeded account's email matches a real row (needed so
    // ensureCloudflareUser and email-based lookups behave consistently
    // elsewhere), so an email invite to any of them actually resolves
    // target_user_id to that account -- which means the OR's *second*
    // disjunct (target_user_id === user.id) alone would carry those tests
    // regardless of this one's own mutation. An email nobody's account
    // matches is the only way target_user_id is genuinely null here.
    const requestId = await invite(context, ids.manager, { email: "nobody-yet@example.com", token: "genuinely-unmatched-token1" });
    const response = await commands.cloudflareOrganizationCommand(
      { id: ids.outsider, email: "nobody-yet@example.com" }, false, "accept_invitation",
      { requestId, token: "genuinely-unmatched-token1", shareFutureHistoryConsent: true },
      nextKey("accept-null-target-user-id"), context.bindings,
    );
    assert.equal(response.ok, true);
  } finally {
    context.database.close();
  }
});

test("secretBound's token-length floor is checked before the token is trusted at all, even one that would otherwise hash-match", async () => {
  const context = fixture();
  try {
    // invite_member itself refuses to create an invitation with a token
    // under 24 characters, so the only way to exercise this specific floor
    // is to insert the row directly with a token whose hash we control.
    const shortToken = "short12345";
    const requestId = "90000000-0000-4000-8000-000000000005";
    context.database.prepare(`
      INSERT INTO organization_requests (
        id, organization_id, kind, status, requester_user_id, target_user_id,
        invitation_email, invitation_token_hash, requested_role, expires_at, created_at, updated_at
      ) VALUES (?, ?, 'invitation', 'pending', ?, NULL, ?, ?, 'student', ?, ?, ?)
    `).run(requestId, ids.org, ids.manager, `${ids.outsider}@example.com`, await tokenHash(shortToken), FAR_FUTURE, FIXTURE_NOW, FIXTURE_NOW);
    await expectDenied(
      act(context, ids.outsider, false, "accept_invitation", { requestId, token: shortToken, shareFutureHistoryConsent: true }, "accept-short-token-hash-matches"),
      404, "not_found", "Invitation not found.",
    );
  } finally {
    context.database.close();
  }
});

test("an email invitation is accepted with the correct token by the matching address, case-insensitively", async () => {
  const context = fixture();
  try {
    const requestId = await invite(context, ids.manager, { email: `${ids.outsider}@example.com`, token: "correct-token-value-2468" });
    // A hand-built caller with an upper-cased email: invite_member always
    // lower-cases before storing, so the *stored* invitation_email is never
    // anything but lower-case already -- the only way to actually exercise
    // accept_invitation's own `.toLowerCase()` on the caller's side is to
    // make the caller's email non-lower-case, which context.user()'s fixed
    // convention never is.
    const response = await commands.cloudflareOrganizationCommand(
      { id: ids.outsider, email: `${ids.outsider.toUpperCase()}@EXAMPLE.COM` }, false, "accept_invitation",
      { requestId, token: "correct-token-value-2468", shareFutureHistoryConsent: true },
      nextKey("accept-email-correct-token-case"), context.bindings,
    );
    assert.equal(response.ok, true);
  } finally {
    context.database.close();
  }
});

test("an email invitation with the wrong token, or from a non-matching email, is refused", async () => {
  const context = fixture();
  try {
    const requestId = await invite(context, ids.manager, { email: `${ids.outsider}@example.com`, token: "correct-token-value-2468" });
    // Also >= 24 characters, deliberately: a token short enough to fail the
    // length check on its own would never reach the hash comparison at all.
    await expectDenied(
      act(context, ids.outsider, false, "accept_invitation", { requestId, token: "wrong-token-value-135790", shareFutureHistoryConsent: true }, "accept-wrong-token"),
      404, "not_found", "Invitation not found.",
    );
    const secondRequestId = await invite(context, ids.manager, { email: "invitee2@example.com", token: "correct-token-value-2468", userId: undefined });
    await expectDenied(
      act(context, ids.outsider2, false, "accept_invitation", { requestId: secondRequestId, token: "correct-token-value-2468", shareFutureHistoryConsent: true }, "accept-wrong-email"),
      404, "not_found", "Invitation not found.",
    );
  } finally {
    context.database.close();
  }
});

test("accept_invitation's own token length floor is exactly 24, independent of invite_member's own minimum", async () => {
  const context = fixture();
  try {
    const requestId = await invite(context, ids.manager, { email: `${ids.outsider}@example.com`, token: "x".repeat(24) });
    // 23 characters must fail length before ever hashing.
    await expectDenied(
      act(context, ids.outsider, false, "accept_invitation", { requestId, token: "x".repeat(23), shareFutureHistoryConsent: true }, "accept-token-too-short"),
      404, "not_found", "Invitation not found.",
    );
    // Exactly 24, and correct, must succeed.
    const response = await act(context, ids.outsider, false, "accept_invitation", { requestId, token: "x".repeat(24), shareFutureHistoryConsent: true }, "accept-token-boundary-ok");
    assert.equal(response.ok, true);
  } finally {
    context.database.close();
  }
});

test("an expired invitation is refused even with the right token", async () => {
  const context = fixture();
  try {
    // Everything else about this invitation is valid (matching email,
    // correct token, an eligible account) so expiry is the only thing that
    // can be responsible for the rejection.
    const requestId = await invite(context, ids.manager, { email: `${ids.outsider}@example.com`, token: "expired-token-value-13579" });
    context.database.prepare("UPDATE organization_requests SET expires_at = ? WHERE id = ?").run(FAR_PAST, requestId);
    await expectDenied(
      act(context, ids.outsider, false, "accept_invitation", { requestId, token: "expired-token-value-13579", shareFutureHistoryConsent: true }, "accept-expired"),
      404, "not_found", "Invitation not found.",
    );
  } finally {
    context.database.close();
  }
});

test("the exact expiry instant itself counts as already expired, not one tick before it", async () => {
  const context = fixture();
  try {
    // <= vs < only disagree at the exact instant expires_at equals "now",
    // an untestable coincidence against the real clock -- Date.now is
    // pinned for the width of this one call so the two can be made to
    // land on precisely the same millisecond.
    const requestId = await invite(context, ids.manager, { userId: ids.outsider });
    const boundary = Date.now() + 60_000;
    context.database.prepare("UPDATE organization_requests SET expires_at = ? WHERE id = ?")
      .run(new Date(boundary).toISOString(), requestId);
    const realDateNow = Date.now;
    Date.now = () => boundary;
    try {
      await expectDenied(
        act(context, ids.outsider, false, "accept_invitation", { requestId, shareFutureHistoryConsent: true }, "accept-expiry-boundary"),
        404, "not_found", "Invitation not found.",
      );
    } finally {
      Date.now = realDateNow;
    }
  } finally {
    context.database.close();
  }
});

test("an invitation with no requested_role at all is refused, not treated as if it had one", async () => {
  const context = fixture();
  try {
    // invite_member always writes a real role; this is otherwise a
    // perfectly valid, accountBound, unexpired, pending invitation, with
    // requested_role hand-cleared to isolate this one guard.
    const requestId = "90000000-0000-4000-8000-000000000007";
    context.database.prepare(`
      INSERT INTO organization_requests (id, organization_id, kind, status, requester_user_id, target_user_id, invitation_token_hash, requested_role, expires_at, created_at, updated_at)
      VALUES (?, ?, 'invitation', 'pending', ?, ?, 'deadbeef', NULL, ?, ?, ?)
    `).run(requestId, ids.org, ids.manager, ids.outsider2, FAR_FUTURE, FIXTURE_NOW, FIXTURE_NOW);
    await expectDenied(
      act(context, ids.outsider2, false, "accept_invitation", { requestId, shareFutureHistoryConsent: true }, "accept-no-requested-role"),
      404, "not_found", "Invitation not found.",
    );
  } finally {
    context.database.close();
  }
});

test("accepting a student invitation still requires eligibility", async () => {
  const context = fixture();
  try {
    // Invited while eligible (so invite_member's own eligibility gate lets it
    // through); eligibility is then withdrawn before the invitation is
    // accepted, isolating accept_invitation's *own* re-check at line 801.
    // ids.outsider2 (unlike ids.outsider) holds no seat allocation anywhere
    // in the fixture, so deleting its subscription actually removes
    // eligibility rather than leaving the seat-based path to satisfy it.
    const requestId = await invite(context, ids.manager, { userId: ids.outsider2 });
    context.database.prepare("DELETE FROM subscriptions WHERE user_id = ?").run(ids.outsider2);
    await expectDenied(
      act(context, ids.outsider2, false, "accept_invitation", { requestId, shareFutureHistoryConsent: true }, "accept-ineligible"),
      400, "validation", "An eligible plan or seat is required.",
    );
  } finally {
    context.database.close();
  }
});

test("accepting a teacher invitation is never gated on student eligibility", async () => {
  const context = fixture();
  try {
    // ids.ineligible has no subscription and no seat allocation anywhere in
    // the fixture, and is invited as a teacher specifically: the eligibility
    // re-check must not apply outside requestedRole === "student".
    const requestId = await invite(context, ids.manager, { userId: ids.ineligible, role: "teacher" });
    const response = await act(context, ids.ineligible, false, "accept_invitation", { requestId, shareFutureHistoryConsent: true }, "accept-teacher-ineligible-ok");
    assert.equal(response.ok, true);
  } finally {
    context.database.close();
  }
});

test("accepting refuses an already-live membership but accepts into a removed one, and cancels other pending invitations for the same person", async () => {
  const context = fixture();
  try {
    // ids.student2 is already an active member, so invite_member's own
    // "already has a membership" check (712) would refuse this invitation
    // outright -- accept_invitation's *own* check (803) needs a person who
    // was invited *before* acquiring a live membership through some other
    // route (here, a separately approved join request), so the invitation is
    // still pending when the conflicting membership shows up.
    const liveRequestId = await invite(context, ids.manager, { userId: ids.outsider, role: "teacher" });
    await act(context, ids.outsider, false, "request_to_join", { organizationId: ids.org, shareFutureHistoryConsent: true }, "accept-conflict-join-seed");
    const joinRequestId = context.database.prepare(
      "SELECT id FROM organization_requests WHERE organization_id = ? AND requester_user_id = ? AND kind = 'join' ORDER BY created_at DESC LIMIT 1",
    ).get(ids.org, ids.outsider).id;
    await act(context, ids.manager, false, "decide_join_request", { requestId: joinRequestId, approve: true }, "accept-conflict-join-approve");
    await expectDenied(
      act(context, ids.outsider, false, "accept_invitation", { requestId: liveRequestId, shareFutureHistoryConsent: true }, "accept-already-live"),
      409, "conflict", "You already have an active membership in this organisation.",
    );

    // A removed member accepting: the existing row is reused (role/status set
    // on it), not a second membership row inserted.
    const accountInviteId = await invite(context, ids.manager, { userId: ids.removedStudent, role: "teacher" });
    // A second, independently-pending invitation naming the same person by
    // email, hand-inserted directly: invite_member's own duplicate-invitation
    // guard (line 730) resolves this email to the same account and would
    // otherwise refuse to create a second live invitation for it. This is
    // exactly the state accept_invitation's own cleanup (823-835) exists for
    // -- an invitation created before the two were known to be the same
    // person, or carried over some other way.
    const staleInviteId = "90000000-0000-4000-8000-000000000003";
    context.database.prepare(`
      INSERT INTO organization_requests (
        id, organization_id, kind, status, requester_user_id, target_user_id,
        invitation_email, invitation_token_hash, requested_role, expires_at, created_at, updated_at
      ) VALUES (?, ?, 'invitation', 'pending', ?, NULL, ?, 'deadbeef', 'teacher', ?, ?, ?)
    `).run(staleInviteId, ids.org, ids.manager, `${ids.removedStudent}@example.com`, FAR_FUTURE, FIXTURE_NOW, FIXTURE_NOW);

    const accepted = await act(context, ids.removedStudent, false, "accept_invitation", { requestId: accountInviteId, shareFutureHistoryConsent: true }, "accept-removed-reuse");
    assert.equal(accepted.ok, true);
    const membership = membershipRow(context, ids.org, ids.removedStudent);
    assert.equal(membership.status, "active");
    assert.equal(membership.role, "teacher");
    assert.equal(
      context.database.prepare("SELECT count(*) AS total FROM organization_memberships WHERE organization_id = ? AND user_id = ?").get(ids.org, ids.removedStudent).total,
      1,
      "acceptance must update the existing row, not insert a second one",
    );
    assert.equal(requestRow(context, staleInviteId).status, "cancelled", "the other pending invitation to the same person must be cancelled");
  } finally {
    context.database.close();
  }
});

test("the cancel-other-invitations query's caller-email fallback is a real empty string, not a sentinel", async () => {
  const context = fixture();
  try {
    // Every ordinary caller in this suite carries a real email, so
    // `user.email?.toLowerCase() ?? X` never actually falls back -- a caller
    // with no email at all is the only way to observe X itself, and
    // accountBound accepting does not depend on user.email either way.
    const staleEmptyEmailInviteId = "90000000-0000-4000-8000-000000000008";
    context.database.prepare(`
      INSERT INTO organization_requests (
        id, organization_id, kind, status, requester_user_id, target_user_id,
        invitation_email, invitation_token_hash, requested_role, expires_at, created_at, updated_at
      ) VALUES (?, ?, 'invitation', 'pending', ?, NULL, ?, 'deadbeef', 'teacher', ?, ?, ?)
    `).run(staleEmptyEmailInviteId, ids.org, ids.manager, "", FAR_FUTURE, FIXTURE_NOW, FIXTURE_NOW);
    const accountInviteId = await invite(context, ids.manager, { userId: ids.outsider2, role: "teacher" });
    const accepted = await commands.cloudflareOrganizationCommand(
      { id: ids.outsider2, email: null }, false, "accept_invitation",
      { requestId: accountInviteId, shareFutureHistoryConsent: true },
      nextKey("accept-null-caller-email"), context.bindings,
    );
    assert.equal(accepted.ok, true);
    assert.equal(requestRow(context, staleEmptyEmailInviteId).status, "cancelled");
  } finally {
    context.database.close();
  }
});

// ---------------------------------------------------------------------------
// assign_teacher / assign_teacher_batch / unassign_teacher (841-877)
// ---------------------------------------------------------------------------

test("assign_teacher's own id() label names the organisation for a malformed id", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "assign_teacher", { organizationId: "not-a-uuid", teacherUserId: ids.teacher, studentUserId: ids.student2 }, "assign-malformed-org-id"),
      400, "validation", "Invalid organisation.",
    );
  } finally {
    context.database.close();
  }
});

test("assign_teacher's teacherUserId label names the teacher for a malformed id", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "assign_teacher", { organizationId: ids.org, teacherUserId: "not-a-uuid", studentUserId: ids.student2 }, "assign-malformed-teacher-id"),
      400, "validation", "Invalid teacher.",
    );
  } finally {
    context.database.close();
  }
});

test("assigning a teacher requires manage rights and an active teacher membership for the teacher side", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.teacher, false, "assign_teacher", { organizationId: ids.org, teacherUserId: ids.teacher2, studentUserId: ids.student2 }, "assign-forbidden"),
      403, "forbidden",
    );
    await expectDenied(
      act(context, ids.manager, false, "assign_teacher", { organizationId: ids.org, teacherUserId: ids.suspendedTeacher, studentUserId: ids.student2 }, "assign-teacher-not-active"),
      400, "validation", "Teacher is not active.",
    );
    await expectDenied(
      act(context, ids.manager, false, "assign_teacher", { organizationId: ids.org, teacherUserId: ids.student, studentUserId: ids.student2 }, "assign-teacher-wrong-role"),
      400, "validation", "Teacher is not active.",
    );
  } finally {
    context.database.close();
  }
});

test("assign_teacher_batch's own per-item id() label names the student for a malformed entry", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "assign_teacher_batch", { organizationId: ids.org, teacherUserId: ids.teacher, studentUserIds: ["not-a-uuid"] }, "batch-teacher-malformed-student"),
      400, "validation", "Invalid student.",
    );
  } finally {
    context.database.close();
  }
});

test("assign_teacher's own single-student id() label names the student for a malformed id", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "assign_teacher", { organizationId: ids.org, teacherUserId: ids.teacher, studentUserId: "not-a-uuid" }, "assign-single-malformed-student"),
      400, "validation", "Invalid student.",
    );
  } finally {
    context.database.close();
  }
});

test("assign_teacher_batch requires studentUserIds to actually be an array", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "assign_teacher_batch", { organizationId: ids.org, teacherUserId: ids.teacher, studentUserIds: ids.student2 }, "batch-teacher-not-array"),
      400, "validation", "Choose students.",
    );
  } finally {
    context.database.close();
  }
});

test("assign_teacher_batch de-duplicates student ids and bounds the batch to 1-500", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "assign_teacher_batch", { organizationId: ids.org, teacherUserId: ids.teacher, studentUserIds: [] }, "batch-teacher-zero"),
      400, "validation", "Choose between 1 and 500 students.",
    );
    const single = await act(context, ids.manager, false, "assign_teacher_batch", { organizationId: ids.org, teacherUserId: ids.teacher, studentUserIds: [ids.student2] }, "batch-teacher-one-ok");
    assert.equal(single.ok, true, "exactly one student is the lower boundary and must be accepted");
    const tooMany = Array.from({ length: 501 }, (_, index) => `50000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`);
    await expectDenied(
      act(context, ids.manager, false, "assign_teacher_batch", { organizationId: ids.org, teacherUserId: ids.teacher, studentUserIds: tooMany }, "batch-teacher-501"),
      400, "validation", "Choose between 1 and 500 students.",
    );
    const exactly500 = tooMany.slice(1);
    await expectDenied(
      act(context, ids.manager, false, "assign_teacher_batch", { organizationId: ids.org, teacherUserId: ids.teacher, studentUserIds: exactly500 }, "batch-teacher-500"),
      400, "validation", "Student is not active.",
      "exactly 500 must pass the bound check and fail later, on membership, not on the count",
    );
    // Duplicate ids collapse to one real assignment.
    await act(context, ids.manager, false, "assign_teacher_batch", {
      organizationId: ids.org, teacherUserId: ids.teacher2, studentUserIds: [ids.student3, ids.student3],
    }, "batch-teacher-dedupe");
    assert.equal(
      context.database.prepare(
        "SELECT count(*) AS total FROM teacher_student_assignments WHERE organization_id = ? AND teacher_user_id = ? AND student_user_id = ?",
      ).get(ids.org, ids.teacher2, ids.student3).total,
      1,
    );
  } finally {
    context.database.close();
  }
});

test("every student in an assignment batch must be an active or leave-requested student", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "assign_teacher", { organizationId: ids.org, teacherUserId: ids.teacher, studentUserId: ids.suspendedStudent }, "assign-student-suspended"),
      400, "validation", "Student is not active.",
    );
    await expectDenied(
      act(context, ids.manager, false, "assign_teacher", { organizationId: ids.org, teacherUserId: ids.teacher, studentUserId: ids.manager2 }, "assign-student-wrong-role"),
      400, "validation", "Student is not active.",
    );
    const leaveRequested = await act(context, ids.manager, false, "assign_teacher", { organizationId: ids.org, teacherUserId: ids.teacher, studentUserId: ids.leaveReqStudent }, "assign-student-leave-requested-ok");
    assert.equal(leaveRequested.ok, true, "leave_requested must still be assignable");
  } finally {
    context.database.close();
  }
});

test("assign_teacher writes the pairing and audits it; unassign_teacher revokes without deleting the row", async () => {
  const context = fixture();
  try {
    const assigned = await act(context, ids.manager, false, "assign_teacher", { organizationId: ids.org, teacherUserId: ids.teacher, studentUserId: ids.student2 }, "assign-effect");
    assert.equal(assigned.ok, true);
    const row = context.database.prepare(
      "SELECT revoked_at FROM teacher_student_assignments WHERE organization_id = ? AND teacher_user_id = ? AND student_user_id = ?",
    ).get(ids.org, ids.teacher, ids.student2);
    assert.equal(row.revoked_at, null);
    const [audit] = auditRows(context, "assign_teacher");
    assert.equal(audit.target_type, "assignment");
    assert.deepEqual(JSON.parse(audit.metadata_json), { teacherUserId: ids.teacher, studentUserIds: [ids.student2] });

    const unassigned = await act(context, ids.manager, false, "unassign_teacher", { organizationId: ids.org, teacherUserId: ids.teacher, studentUserId: ids.student2 }, "unassign-effect");
    assert.equal(unassigned.ok, true);
    const revoked = context.database.prepare(
      "SELECT revoked_at FROM teacher_student_assignments WHERE organization_id = ? AND teacher_user_id = ? AND student_user_id = ?",
    ).get(ids.org, ids.teacher, ids.student2);
    assert.ok(revoked.revoked_at, "unassign must revoke, not delete, the pairing");
  } finally {
    context.database.close();
  }
});

// ---------------------------------------------------------------------------
// assign_practice / assign_practice_batch / remove_practice_assignment (879-980)
// ---------------------------------------------------------------------------

async function assignPractice(context, actorId, studentUserIds, overrides = {}) {
  const single = !Array.isArray(studentUserIds);
  return act(context, actorId, false, single ? "assign_practice" : "assign_practice_batch", {
    organizationId: ids.org,
    ...(single ? { studentUserId: studentUserIds } : { studentUserIds }),
    skill: "writing", testId: "next-writing",
    ...overrides,
  }, "assign-practice");
}

test("assign_practice's own id() label names the organisation for a malformed id", async () => {
  const context = fixture();
  try {
    await expectDenied(
      assignPractice(context, ids.manager, ids.student, { organizationId: "not-a-uuid" }),
      400, "validation", "Invalid organisation.",
    );
  } finally {
    context.database.close();
  }
});

test("removing a practice assignment requires the target student to be active, and manage rights or the assigning teacher's own assignment", async () => {
  const context = fixture();
  try {
    const created = await assignPractice(context, ids.manager, ids.student);
    assert.equal(created.ok, true);
    const assignmentId = context.database.prepare(
      "SELECT id FROM organization_practice_assignments WHERE organization_id = ? AND student_user_id = ?",
    ).get(ids.org, ids.student).id;

    await expectDenied(
      act(context, ids.manager, false, "remove_practice_assignment", { organizationId: ids.org, studentUserId: ids.suspendedStudent, assignmentId }, "remove-practice-student-inactive"),
      400, "validation", "Student is not active.",
    );
    await expectDenied(
      act(context, ids.teacher2, false, "remove_practice_assignment", { organizationId: ids.org, studentUserId: ids.student, assignmentId }, "remove-practice-forbidden"),
      403, "forbidden",
    );
    const removed = await act(context, ids.teacher, false, "remove_practice_assignment", { organizationId: ids.org, studentUserId: ids.student, assignmentId }, "remove-practice-teacher-ok");
    assert.equal(removed.ok, true, "the assigned teacher may remove their own assignment");
    assert.equal(
      context.database.prepare("SELECT count(*) AS total FROM organization_practice_assignments WHERE id = ?").get(assignmentId).total,
      0,
    );
    const [removeAudit] = auditRows(context, "remove_practice_assignment");
    assert.equal(removeAudit.target_type, "practice_assignment");
  } finally {
    context.database.close();
  }
});

test("remove_practice_assignment requires the target to actually be a student, not merely active", async () => {
  const context = fixture();
  try {
    // organization_practice_assignments carries no role constraint on
    // student_user_id at the database level, so a row naming a non-student
    // (here, an active teacher) is otherwise indistinguishable from a real
    // one by status alone -- only the role check itself catches it.
    const assignmentId = "80000000-0000-4000-8000-000000000050";
    context.database.prepare(`
      INSERT INTO organization_practice_assignments (id, organization_id, assigned_by_user_id, student_user_id, module, test_id, test_title, assigned_at, updated_at)
      VALUES (?, ?, ?, ?, 'writing', 'next-writing', 'Writing', ?, ?)
    `).run(assignmentId, ids.org, ids.manager, ids.teacher2, FIXTURE_NOW, FIXTURE_NOW);
    await expectDenied(
      act(context, ids.manager, false, "remove_practice_assignment", { organizationId: ids.org, studentUserId: ids.teacher2, assignmentId }, "remove-practice-target-not-student"),
      400, "validation", "Student is not active.",
    );
  } finally {
    context.database.close();
  }
});

test("remove_practice_assignment still allows a leave-requested (not just fully active) student target", async () => {
  const context = fixture();
  try {
    const created = await assignPractice(context, ids.manager, ids.leaveReqStudent);
    assert.equal(created.ok, true);
    const assignmentId = context.database.prepare(
      "SELECT id FROM organization_practice_assignments WHERE organization_id = ? AND student_user_id = ?",
    ).get(ids.org, ids.leaveReqStudent).id;
    const removed = await act(context, ids.manager, false, "remove_practice_assignment", { organizationId: ids.org, studentUserId: ids.leaveReqStudent, assignmentId }, "remove-practice-leave-requested-ok");
    assert.equal(removed.ok, true);
  } finally {
    context.database.close();
  }
});

test("remove_practice_assignment's teacherAllowed genuinely requires the actor's role to be teacher", async () => {
  const context = fixture();
  try {
    // A non-teacher (role student) actor manually given an assignment row --
    // canManage would already grant a manager or owner access regardless, so
    // isolating this check needs a non-manage role paired with an
    // assignment row the real command flow could never leave them holding.
    context.database.prepare(`
      INSERT INTO teacher_student_assignments (id, organization_id, teacher_user_id, student_user_id, assigned_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("72000000-0000-4000-8000-000000000003", ids.org, ids.student2, ids.student3, ids.manager, FIXTURE_NOW);
    const created = await assignPractice(context, ids.manager, ids.student3);
    const assignmentId = context.database.prepare(
      "SELECT id FROM organization_practice_assignments WHERE organization_id = ? AND student_user_id = ?",
    ).get(ids.org, ids.student3).id;
    assert.equal(created.ok, true);
    await expectDenied(
      act(context, ids.student2, false, "remove_practice_assignment", { organizationId: ids.org, studentUserId: ids.student3, assignmentId }, "remove-practice-non-teacher-actor"),
      403, "forbidden",
    );
  } finally {
    context.database.close();
  }
});

test("remove_practice_assignment's own studentUserId label names the student for a malformed id", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "remove_practice_assignment", { organizationId: ids.org, studentUserId: "not-a-uuid", assignmentId: "80000000-0000-4000-8000-000000000099" }, "remove-practice-malformed-student"),
      400, "validation", "Invalid student.",
    );
  } finally {
    context.database.close();
  }
});

test("remove_practice_assignment's own assignmentId label names the assignment for a malformed id", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "remove_practice_assignment", { organizationId: ids.org, studentUserId: ids.student, assignmentId: "not-a-uuid" }, "remove-practice-malformed-assignment-id"),
      400, "validation", "Invalid practice assignment.",
    );
  } finally {
    context.database.close();
  }
});

test("a practice assignment cannot be removed under someone else's student id", async () => {
  const context = fixture();
  try {
    await assignPractice(context, ids.manager, ids.student2);
    const assignmentId = context.database.prepare(
      "SELECT id FROM organization_practice_assignments WHERE organization_id = ? AND student_user_id = ?",
    ).get(ids.org, ids.student2).id;
    await expectDenied(
      act(context, ids.manager, false, "remove_practice_assignment", { organizationId: ids.org, studentUserId: ids.student3, assignmentId }, "remove-practice-wrong-student"),
      404, "not_found", "Practice assignment not found.",
    );
  } finally {
    context.database.close();
  }
});

test("assign_practice_batch's own per-item id() label names the student for a malformed entry", async () => {
  const context = fixture();
  try {
    await expectDenied(
      assignPractice(context, ids.manager, ["not-a-uuid"]),
      400, "validation", "Invalid student.",
    );
  } finally {
    context.database.close();
  }
});

test("assign_practice's own single-student id() label names the student for a malformed id", async () => {
  const context = fixture();
  try {
    await expectDenied(
      assignPractice(context, ids.manager, "not-a-uuid"),
      400, "validation", "Invalid student.",
    );
  } finally {
    context.database.close();
  }
});

test("assign_practice_batch requires studentUserIds to actually be an array", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "assign_practice_batch", { organizationId: ids.org, studentUserIds: ids.student2, skill: "writing", testId: "next-writing" }, "assign-practice-batch-not-array"),
      400, "validation", "Choose students.",
    );
  } finally {
    context.database.close();
  }
});

test("assign_practice_batch bounds the batch to 1-40 and requires every student to be currently active", async () => {
  const context = fixture();
  try {
    await expectDenied(
      assignPractice(context, ids.manager, [], {}),
      400, "validation", "Choose between 1 and 40 students.",
    );
    const tooMany = Array.from({ length: 41 }, (_, index) => `50000000-0000-4000-8000-${String(index + 200).padStart(12, "0")}`);
    await expectDenied(
      assignPractice(context, ids.manager, tooMany),
      400, "validation", "Choose between 1 and 40 students.",
    );
    const exactly40 = tooMany.slice(1);
    await expectDenied(
      assignPractice(context, ids.manager, exactly40),
      400, "validation", "Student is not active.",
      "exactly 40 must pass the bound check and fail later, on membership",
    );
    await expectDenied(
      assignPractice(context, ids.manager, [ids.suspendedStudent]),
      400, "validation", "Student is not active.",
    );
  } finally {
    context.database.close();
  }
});

test("assigning practice as a teacher requires every student to be assigned to that teacher", async () => {
  const context = fixture();
  try {
    await expectDenied(
      assignPractice(context, ids.teacher, ids.student2),
      403, "forbidden",
    );
    const ok = await assignPractice(context, ids.teacher, ids.student);
    assert.equal(ok.ok, true, "the teacher's own assigned student must be allowed");
    // Batch: if even one of several students is not assigned to this teacher,
    // the whole batch is forbidden.
    await act(context, ids.manager, false, "assign_teacher", { organizationId: ids.org, teacherUserId: ids.teacher, studentUserId: ids.student3 }, "batch-practice-assign-one");
    await expectDenied(
      assignPractice(context, ids.teacher, [ids.student, ids.student3, ids.student2]),
      403, "forbidden",
    );
  } finally {
    context.database.close();
  }
});

test("a non-manage actor who is not actually a teacher is forbidden immediately, without even consulting teacher_student_assignments", async () => {
  const context = fixture();
  try {
    // A non-teacher (role student) actor manually given an assignment row --
    // if the actorRole check here were skipped, the query for its assigned
    // students would find this anomalous row and let the assignment
    // through.
    context.database.prepare(`
      INSERT INTO teacher_student_assignments (id, organization_id, teacher_user_id, student_user_id, assigned_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("72000000-0000-4000-8000-000000000004", ids.org, ids.student2, ids.student3, ids.manager, FIXTURE_NOW);
    await expectDenied(
      assignPractice(context, ids.student2, ids.student3),
      403, "forbidden",
    );
  } finally {
    context.database.close();
  }
});

test("assign_practice validates the practice target and the optional due date", async () => {
  const context = fixture();
  try {
    await expectDenied(
      assignPractice(context, ids.manager, ids.student, { skill: "reading", testId: "no-such-test-id" }),
      400, "validation", "Choose a BandUp practice item.",
    );
    await expectDenied(
      assignPractice(context, ids.manager, ids.student, { dueAt: "not a date" }),
      400, "validation", "Invalid due date.",
    );
    const withDueDate = await assignPractice(context, ids.manager, ids.student2, { dueAt: "2026-09-01T00:00:00.000Z", note: "  finish before class  " });
    assert.equal(withDueDate.ok, true);
    const row = context.database.prepare(
      "SELECT note, due_at, module, test_id FROM organization_practice_assignments WHERE organization_id = ? AND student_user_id = ?",
    ).get(ids.org, ids.student2);
    assert.equal(row.note, "finish before class");
    assert.equal(row.due_at, "2026-09-01T00:00:00.000Z");
    assert.equal(row.module, "writing");
    assert.equal(row.test_id, "next-writing");
  } finally {
    context.database.close();
  }
});

test("assign_practice_batch writes one assignment and one notification per student, and audits the whole batch", async () => {
  const context = fixture();
  try {
    const response = await assignPractice(context, ids.manager, [ids.student2, ids.student3]);
    assert.equal(response.ok, true);
    const assignments = context.database.prepare(
      "SELECT student_user_id, assigned_by_user_id FROM organization_practice_assignments WHERE organization_id = ? ORDER BY student_user_id",
    ).all(ids.org).filter((row) => row.student_user_id === ids.student2 || row.student_user_id === ids.student3);
    assert.equal(assignments.length, 2);
    const notified = context.database.prepare(
      "SELECT count(*) AS total FROM user_notifications WHERE kind = 'practice_assigned' AND recipient_user_id IN (?, ?)",
    ).get(ids.student2, ids.student3).total;
    assert.equal(notified, 2);
    const [audit] = auditRows(context, "assign_practice_batch");
    assert.equal(audit.target_type, "practice_assignment_batch");
    const metadata = JSON.parse(audit.metadata_json);
    assert.equal(metadata.skill, "writing");
    assert.equal(metadata.testId, "next-writing");
    assert.equal(metadata.assignmentIds.length, 2);
    assert.ok(metadata.assignmentIds.every((id) => typeof id === "string" && id.length > 0));
  } finally {
    context.database.close();
  }
});

// ---------------------------------------------------------------------------
// save_teacher_feedback / remove_teacher_feedback (982-1034)
// ---------------------------------------------------------------------------

test("save_teacher_feedback's own id() labels name the organisation and the attempt for a malformed id", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "save_teacher_feedback", { organizationId: "not-a-uuid", attemptId: context.attemptIds.shareable, message: "Nice work" }, "feedback-malformed-org-id"),
      400, "validation", "Invalid organisation.",
    );
    await expectDenied(
      act(context, ids.manager, false, "save_teacher_feedback", { organizationId: ids.org, attemptId: "not-a-uuid", message: "Nice work" }, "feedback-malformed-attempt-id"),
      400, "validation", "Invalid attempt.",
    );
  } finally {
    context.database.close();
  }
});

test("teacher feedback can only be attached to an attempt that is actually in scope for this organisation", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "save_teacher_feedback", { organizationId: ids.org, attemptId: context.attemptIds.outOfScope, message: "Nice work" }, "feedback-out-of-scope"),
      404, "not_found", "Sitting not found.",
    );
    await expectDenied(
      act(context, ids.manager, false, "save_teacher_feedback", { organizationId: ids.org, attemptId: context.attemptIds.tombstoned, message: "Nice work" }, "feedback-tombstoned"),
      404, "not_found", "Sitting not found.",
    );
  } finally {
    context.database.close();
  }
});


test("only manage rights or the student's assigned teacher may leave or remove feedback", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.teacher2, false, "save_teacher_feedback", { organizationId: ids.org, attemptId: context.attemptIds.shareable, message: "Nice work" }, "feedback-forbidden"),
      403, "forbidden",
    );
    const saved = await act(context, ids.teacher, false, "save_teacher_feedback", { organizationId: ids.org, attemptId: context.attemptIds.shareable, message: "Nice work" }, "feedback-teacher-ok");
    assert.equal(saved.ok, true);
  } finally {
    context.database.close();
  }
});

test("save_teacher_feedback's teacherAllowed genuinely requires the actor's role to be teacher", async () => {
  const context = fixture();
  try {
    // A non-teacher (role student) actor manually given an assignment row --
    // canManage would already grant a manager or owner access regardless, so
    // isolating this needs a non-manage role paired with an assignment row
    // the real command flow could never leave them holding.
    context.database.prepare(`
      INSERT INTO teacher_student_assignments (id, organization_id, teacher_user_id, student_user_id, assigned_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("72000000-0000-4000-8000-000000000005", ids.org, ids.student2, ids.student, ids.manager, FIXTURE_NOW);
    await expectDenied(
      act(context, ids.student2, false, "save_teacher_feedback", { organizationId: ids.org, attemptId: context.attemptIds.shareable, message: "Nice work" }, "feedback-non-teacher-actor"),
      403, "forbidden",
    );
  } finally {
    context.database.close();
  }
});

test("remove_teacher_feedback's own feedbackId label names the feedback for a malformed id", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "remove_teacher_feedback", { organizationId: ids.org, attemptId: context.attemptIds.shareable, feedbackId: "not-a-uuid" }, "feedback-malformed-id"),
      400, "validation", "Invalid feedback.",
    );
  } finally {
    context.database.close();
  }
});

test("a teacher may only remove their own feedback; a manager may remove anyone's", async () => {
  const context = fixture();
  try {
    await act(context, ids.teacher, false, "save_teacher_feedback", { organizationId: ids.org, attemptId: context.attemptIds.shareable, message: "From the teacher" }, "feedback-teacher-authored");
    const feedbackId = context.database.prepare(
      "SELECT id FROM organization_teacher_feedback WHERE organization_id = ? AND attempt_id = ? AND teacher_user_id = ?",
    ).get(ids.org, context.attemptIds.shareable, ids.teacher).id;

    // remove_teacher_feedback's own authorization still requires the teacher
    // to be assigned to the student -- but its ownOnly *delete clause* is a
    // second, independent gate: it deletes nothing when the row belongs to a
    // different teacher, and the command still reports ok:true.
    await act(context, ids.manager, false, "assign_teacher", { organizationId: ids.org, teacherUserId: ids.teacher2, studentUserId: ids.student }, "feedback-second-teacher-assign");
    const silentlyNoOp = await act(context, ids.teacher2, false, "remove_teacher_feedback", {
      organizationId: ids.org, attemptId: context.attemptIds.shareable, feedbackId,
    }, "feedback-remove-other-teacher-noop");
    assert.equal(silentlyNoOp.ok, true);
    assert.equal(
      context.database.prepare("SELECT count(*) AS total FROM organization_teacher_feedback WHERE id = ?").get(feedbackId).total,
      1,
      "a teacher's ownOnly delete must not remove another teacher's feedback row",
    );

    // The author removing their own feedback is the ownOnly path's matching
    // case: the bind list must actually carry the extra teacher_user_id
    // parameter the SQL's own placeholder count expects.
    const ownRemoved = await act(context, ids.teacher, false, "remove_teacher_feedback", {
      organizationId: ids.org, attemptId: context.attemptIds.shareable, feedbackId,
    }, "feedback-remove-own-ok");
    assert.equal(ownRemoved.ok, true);
    assert.equal(
      context.database.prepare("SELECT count(*) AS total FROM organization_teacher_feedback WHERE id = ?").get(feedbackId).total,
      0,
      "the author must be able to remove their own feedback",
    );

    await act(context, ids.teacher2, false, "save_teacher_feedback", { organizationId: ids.org, attemptId: context.attemptIds.shareable, message: "From the second teacher" }, "feedback-second-teacher-authored");
    const secondFeedbackId = context.database.prepare(
      "SELECT id FROM organization_teacher_feedback WHERE organization_id = ? AND attempt_id = ? AND teacher_user_id = ?",
    ).get(ids.org, context.attemptIds.shareable, ids.teacher2).id;
    const managerRemoved = await act(context, ids.manager, false, "remove_teacher_feedback", {
      organizationId: ids.org, attemptId: context.attemptIds.shareable, feedbackId: secondFeedbackId,
    }, "feedback-remove-manager-ok");
    assert.equal(managerRemoved.ok, true);
    assert.equal(
      context.database.prepare("SELECT count(*) AS total FROM organization_teacher_feedback WHERE id = ?").get(secondFeedbackId).total,
      0,
      "a manager's delete is not restricted to their own authored feedback",
    );
    const [removeAudit] = auditRows(context, "remove_teacher_feedback");
    assert.equal(removeAudit.target_type, "teacher_feedback");
  } finally {
    context.database.close();
  }
});

test("teacher feedback message is bounded 1-3000 characters, and saving twice upserts by (organisation, attempt, teacher)", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.teacher, false, "save_teacher_feedback", { organizationId: ids.org, attemptId: context.attemptIds.shareable, message: "" }, "feedback-empty"),
      400, "validation", "Invalid feedback.",
    );
    await expectDenied(
      act(context, ids.teacher, false, "save_teacher_feedback", { organizationId: ids.org, attemptId: context.attemptIds.shareable, message: "x".repeat(3001) }, "feedback-too-long"),
      400, "validation", "Invalid feedback.",
    );
    await act(context, ids.teacher, false, "save_teacher_feedback", { organizationId: ids.org, attemptId: context.attemptIds.shareable, message: "First draft" }, "feedback-first");
    await act(context, ids.teacher, false, "save_teacher_feedback", { organizationId: ids.org, attemptId: context.attemptIds.shareable, message: "Revised draft" }, "feedback-second");
    const rows = context.database.prepare(
      "SELECT message FROM organization_teacher_feedback WHERE organization_id = ? AND attempt_id = ? AND teacher_user_id = ?",
    ).all(ids.org, context.attemptIds.shareable, ids.teacher);
    assert.equal(rows.length, 1, "a second save by the same teacher must update, not duplicate");
    assert.equal(rows[0].message, "Revised draft");
    const notified = context.database.prepare(
      "SELECT count(*) AS total FROM user_notifications WHERE kind = 'teacher_feedback' AND recipient_user_id = ?",
    ).get(ids.student).total;
    assert.equal(notified, 2, "each save (not only the first) must notify the student");
    const [audit] = auditRows(context, "save_teacher_feedback").filter((row) => row.target_id === context.attemptIds.shareable);
    assert.equal(audit.target_type, "teacher_feedback");
    assert.equal(JSON.parse(audit.metadata_json).studentUserId, ids.student);
  } finally {
    context.database.close();
  }
});

// ---------------------------------------------------------------------------
// change_member_role / suspend_member / restore_member / remove_member (1036-1111)
// ---------------------------------------------------------------------------

test("member actions' own id() labels name the organisation and the member for malformed ids", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "suspend_member", { organizationId: "not-a-uuid", userId: ids.student2 }, "member-malformed-org-id"),
      400, "validation", "Invalid organisation.",
    );
    await expectDenied(
      act(context, ids.manager, false, "suspend_member", { organizationId: ids.org, userId: "not-a-uuid" }, "member-malformed-user-id"),
      400, "validation", "Invalid member.",
    );
  } finally {
    context.database.close();
  }
});

test("member actions require manage rights and accept either the userId or targetUserId payload key", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.teacher, false, "suspend_member", { organizationId: ids.org, userId: ids.student2 }, "member-forbidden"),
      403, "forbidden",
    );
    const viaUserId = await act(context, ids.manager, false, "suspend_member", { organizationId: ids.org, userId: ids.student2 }, "member-via-userid");
    assert.equal(viaUserId.ok, true);
    const viaTargetUserId = await act(context, ids.manager, false, "restore_member", { organizationId: ids.org, targetUserId: ids.student2 }, "member-via-targetuserid");
    assert.equal(viaTargetUserId.ok, true);
  } finally {
    context.database.close();
  }
});

test("only platformAdmin may act on an owner, across all four member actions", async () => {
  const context = fixture();
  try {
    for (const action of ["change_member_role", "suspend_member", "restore_member", "remove_member"]) {
      await expectDenied(
        act(context, ids.manager, false, action, { organizationId: ids.org, userId: ids.owner, role: "teacher" }, `owner-guard-${action}`),
        400, "validation", "Only BandUp can manage an owner.",
      );
    }
    assert.equal(membershipRow(context, ids.org, ids.owner).role, "owner");
  } finally {
    context.database.close();
  }
});

test("only an owner or platformAdmin may promote to owner; a manager may promote to any other role", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "change_member_role", { organizationId: ids.org, userId: ids.teacher, role: "owner" }, "promote-owner-by-manager"),
      400, "validation", "Invalid role.",
    );
    const byOwner = await act(context, ids.owner, false, "change_member_role", { organizationId: ids.org, userId: ids.teacher, role: "owner" }, "promote-owner-by-owner");
    assert.equal(byOwner.ok, true);
  } finally {
    context.database.close();
  }
});

test("change_member_role's owner-allowing role() still refuses a role that is not student, teacher, manager or owner", async () => {
  const context = fixture();
  try {
    // change_member_role is the one call site that passes allowOwner=true.
    // A garbage role must still be refused: role()'s final clause is
    // `!allowOwner || value !== "owner"`, and with allowOwner true that
    // collapses to just `value !== "owner"` -- it must not become a no-op
    // that lets any non-owner string through once ownership grants are in
    // play.
    await expectDenied(
      act(context, ids.manager, false, "change_member_role", { organizationId: ids.org, userId: ids.teacher2, role: "principal" }, "change-role-garbage"),
      400, "validation", "Invalid role.",
    );
    assert.equal(membershipRow(context, ids.org, ids.teacher2).role, "teacher");
  } finally {
    context.database.close();
  }
});

test("promoting to student re-checks eligibility, and resets both sharing flags to a fresh joiner's defaults", async () => {
  const context = fixture();
  try {
    // ids.ineligible is deliberately not a member at all (used for join/invite
    // eligibility tests instead); change_member_role's target must already be
    // a member, so this uses ids.memberNoSub -- a real, existing member with
    // no subscription.
    await expectDenied(
      act(context, ids.manager, false, "change_member_role", { organizationId: ids.org, userId: ids.memberNoSub, role: "student" }, "promote-student-ineligible"),
      400, "validation", "The student needs an eligible plan or seat.",
    );
    const response = await act(context, ids.manager, false, "change_member_role", { organizationId: ids.org, userId: ids.manager2, role: "student" }, "promote-student-ok");
    assert.equal(response.ok, true);
    const membership = membershipRow(context, ids.org, ids.manager2);
    assert.equal(membership.role, "student");
    assert.equal(membership.share_future_history, 1);
    assert.equal(membership.share_pre_join_history, 0);
  } finally {
    context.database.close();
  }
});

test("changing role to anything other than student does not touch the sharing flags", async () => {
  const context = fixture();
  try {
    context.database.prepare(
      "UPDATE organization_memberships SET share_future_history = 0 WHERE organization_id = ? AND user_id = ?",
    ).run(ids.org, ids.teacher2);
    await act(context, ids.manager, false, "change_member_role", { organizationId: ids.org, userId: ids.teacher2, role: "manager" }, "promote-manager-keeps-flags");
    const membership = membershipRow(context, ids.org, ids.teacher2);
    assert.equal(membership.role, "manager");
    assert.equal(membership.share_future_history, 0, "an unrelated role change must not force sharing back on");
  } finally {
    context.database.close();
  }
});

test("restore_member requires a suspended target and re-checks student eligibility", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "restore_member", { organizationId: ids.org, userId: ids.teacher2 }, "restore-not-suspended"),
      409, "conflict", "A former member must accept a new invitation before rejoining.",
    );
    // suspendedStudent already carries role student/status suspended in the
    // base fixture; clear its joined_at so restoring can be shown to *set*
    // one, rather than merely leaving an already-present value alone.
    context.database.prepare(
      "UPDATE organization_memberships SET joined_at = NULL WHERE organization_id = ? AND user_id = ?",
    ).run(ids.org, ids.suspendedStudent);
    context.database.prepare(
      "UPDATE organization_memberships SET status = 'suspended' WHERE organization_id = ? AND user_id = ?",
    ).run(ids.org, ids.pendingStudent);
    context.database.prepare(
      "DELETE FROM subscriptions WHERE user_id = ?",
    ).run(ids.pendingStudent);
    await expectDenied(
      act(context, ids.manager, false, "restore_member", { organizationId: ids.org, userId: ids.pendingStudent }, "restore-ineligible"),
      400, "validation", "The student needs an eligible plan or seat.",
    );
    const restored = await act(context, ids.manager, false, "restore_member", { organizationId: ids.org, userId: ids.suspendedStudent }, "restore-ok");
    assert.equal(restored.ok, true);
    const membership = membershipRow(context, ids.org, ids.suspendedStudent);
    assert.equal(membership.status, "active");
    assert.ok(membership.joined_at, "restoring must set joined_at when it was previously unset");

    // The eligibility re-check is gated on the target's role being student;
    // ids.suspendedTeacher holds no subscription or seat allocation, so it
    // must not matter here, only for a student target.
    const restoredTeacher = await act(context, ids.manager, false, "restore_member", { organizationId: ids.org, userId: ids.suspendedTeacher }, "restore-non-student-ineligible-ok");
    assert.equal(restoredTeacher.ok, true);
  } finally {
    context.database.close();
  }
});

test("suspending or removing an ineligible student is not blocked by the restore-only eligibility re-check", async () => {
  const context = fixture();
  try {
    // The eligibility re-check at line 1058 is gated on action ===
    // "restore_member" specifically -- suspending or removing a member has
    // nothing to do with eligibility, and must still succeed even for a
    // student who has since lost theirs. ids.student3 holds no seat
    // allocation anywhere in the fixture, so deleting its subscription
    // actually removes eligibility.
    context.database.prepare("DELETE FROM subscriptions WHERE user_id = ?").run(ids.student3);
    const suspended = await act(context, ids.manager, false, "suspend_member", { organizationId: ids.org, userId: ids.student3 }, "suspend-ineligible-student-ok");
    assert.equal(suspended.ok, true);
  } finally {
    context.database.close();
  }
});

test("only restoring, not suspending or removing, ever sets or touches joined_at", async () => {
  const context = fixture();
  try {
    // ids.pendingStudent has a never-set (null) joined_at in the base
    // fixture; suspend_member's own statement branch must leave it that
    // way, not coalesce it to now the way restore_member's branch does.
    const suspended = await act(context, ids.manager, false, "suspend_member", { organizationId: ids.org, userId: ids.pendingStudent }, "suspend-must-not-set-joined-at");
    assert.equal(suspended.ok, true);
    assert.equal(membershipRow(context, ids.org, ids.pendingStudent).joined_at, null);
  } finally {
    context.database.close();
  }
});

test("suspend_member only changes status; remove_member sets removed_at and revokes teacher assignments either way round", async () => {
  const context = fixture();
  try {
    const suspended = await act(context, ids.manager, false, "suspend_member", { organizationId: ids.org, userId: ids.student2 }, "suspend-effect");
    assert.equal(suspended.ok, true);
    const suspendedRow = membershipRow(context, ids.org, ids.student2);
    assert.equal(suspendedRow.status, "suspended");
    assert.equal(suspendedRow.removed_at, null);

    // Give the student a teacher, and make the teacher a "student" of another
    // teacher too, so removal is tested on both sides of the assignment.
    await act(context, ids.manager, false, "assign_teacher", { organizationId: ids.org, teacherUserId: ids.teacher, studentUserId: ids.student3 }, "remove-member-seed-assignment");
    const removed = await act(context, ids.manager, false, "remove_member", { organizationId: ids.org, userId: ids.student3 }, "remove-effect");
    assert.equal(removed.ok, true);
    const removedRow = membershipRow(context, ids.org, ids.student3);
    assert.equal(removedRow.status, "removed");
    assert.ok(removedRow.removed_at);
    const revoked = context.database.prepare(
      "SELECT revoked_at FROM teacher_student_assignments WHERE organization_id = ? AND teacher_user_id = ? AND student_user_id = ?",
    ).get(ids.org, ids.teacher, ids.student3);
    assert.ok(revoked.revoked_at, "removing a member must revoke their teacher assignments too");

    const [audit] = auditRows(context, "remove_member");
    assert.equal(audit.target_type, "membership");
  } finally {
    context.database.close();
  }
});

test("suspending or restoring a member must not revoke their teacher assignments -- only remove_member and an actual role change do", async () => {
  const context = fixture();
  try {
    // ids.teacher is already assigned to ids.student in the base fixture.
    const revokedAt = () => context.database.prepare(
      "SELECT revoked_at FROM teacher_student_assignments WHERE organization_id = ? AND teacher_user_id = ? AND student_user_id = ?",
    ).get(ids.org, ids.teacher, ids.student).revoked_at;

    const suspended = await act(context, ids.manager, false, "suspend_member", { organizationId: ids.org, userId: ids.student }, "suspend-must-not-revoke-assignment");
    assert.equal(suspended.ok, true);
    assert.equal(revokedAt(), null, "suspending a student must not revoke their teacher's assignment");

    const restored = await act(context, ids.manager, false, "restore_member", { organizationId: ids.org, userId: ids.student }, "restore-must-not-revoke-assignment");
    assert.equal(restored.ok, true);
    assert.equal(revokedAt(), null, "restoring a suspended student must not revoke their teacher's assignment");
  } finally {
    context.database.close();
  }
});

test("changing role revokes teacher assignments only when the role actually changes", async () => {
  const context = fixture();
  try {
    await act(context, ids.manager, false, "assign_teacher", { organizationId: ids.org, teacherUserId: ids.teacher, studentUserId: ids.student2 }, "role-change-seed");
    // No-op role "change" (same role) must not revoke anything.
    await act(context, ids.manager, false, "change_member_role", { organizationId: ids.org, userId: ids.student2, role: "student" }, "role-change-noop");
    assert.equal(
      context.database.prepare(
        "SELECT revoked_at FROM teacher_student_assignments WHERE organization_id = ? AND teacher_user_id = ? AND student_user_id = ?",
      ).get(ids.org, ids.teacher, ids.student2).revoked_at,
      null,
      "an unchanged role must not revoke the assignment",
    );
    await act(context, ids.manager, false, "change_member_role", { organizationId: ids.org, userId: ids.student2, role: "teacher" }, "role-change-actual");
    assert.ok(
      context.database.prepare(
        "SELECT revoked_at FROM teacher_student_assignments WHERE organization_id = ? AND teacher_user_id = ? AND student_user_id = ?",
      ).get(ids.org, ids.teacher, ids.student2).revoked_at,
      "an actual role change must revoke the assignment",
    );
    // The membership audit row must record which role was requested, not a
    // blank metadata blob -- that is the only place the new role survives
    // once the update itself only stores it on organization_memberships.
    const roleChangeAudits = auditRows(context, "change_member_role");
    assert.deepEqual(JSON.parse(roleChangeAudits.at(-1).metadata_json), { role: "teacher" });
  } finally {
    context.database.close();
  }
});

// ---------------------------------------------------------------------------
// archive_attempt / restore_attempt / remove_attempt_permanently (1113-1156)
// ---------------------------------------------------------------------------

test("attempt lifecycle actions' own id() labels name the organisation and the attempt for malformed ids", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "archive_attempt", { organizationId: "not-a-uuid", attemptId: context.attemptIds.shareable }, "attempt-malformed-org-id"),
      400, "validation", "Invalid organisation.",
    );
    await expectDenied(
      act(context, ids.manager, false, "archive_attempt", { organizationId: ids.org, attemptId: "not-a-uuid" }, "attempt-malformed-attempt-id"),
      400, "validation", "Invalid attempt.",
    );
  } finally {
    context.database.close();
  }
});

test("attempt lifecycle actions require the attempt to be in scope for this organisation", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "archive_attempt", { organizationId: ids.org, attemptId: context.attemptIds.outOfScope }, "archive-out-of-scope"),
      404, "not_found", "Attempt not found.",
    );
  } finally {
    context.database.close();
  }
});

test("only permanent removal is restricted to manage rights; archive and restore also allow the assigned teacher", async () => {
  const context = fixture();
  try {
    const archivedByTeacher = await act(context, ids.teacher, false, "archive_attempt", { organizationId: ids.org, attemptId: context.attemptIds.shareable, reason: "duplicate" }, "archive-teacher-ok");
    assert.equal(archivedByTeacher.ok, true);
    await expectDenied(
      act(context, ids.teacher, false, "remove_attempt_permanently", { organizationId: ids.org, attemptId: context.attemptIds.shareable, reason: "duplicate entry" }, "remove-permanent-teacher-forbidden"),
      403, "forbidden",
    );
    await expectDenied(
      act(context, ids.teacher2, false, "archive_attempt", { organizationId: ids.org, attemptId: context.attemptIds.shareable, reason: "duplicate" }, "archive-unassigned-teacher-forbidden"),
      403, "forbidden",
    );
  } finally {
    context.database.close();
  }
});

test("archive_attempt's teacher-allowed check actually requires the teacher role, not just a matching assignment row", async () => {
  const context = fixture();
  try {
    // A non-teacher (role student) actor manually given an assignment row --
    // canManage would already grant a manager or owner access regardless, so
    // isolating this needs a non-manage role paired with an assignment row
    // the real command flow could never leave them holding.
    context.database.prepare(`
      INSERT INTO teacher_student_assignments (id, organization_id, teacher_user_id, student_user_id, assigned_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("72000000-0000-4000-8000-000000000006", ids.org, ids.student2, ids.student, ids.manager, FIXTURE_NOW);
    await expectDenied(
      act(context, ids.student2, false, "archive_attempt", { organizationId: ids.org, attemptId: context.attemptIds.shareable, reason: "duplicate" }, "archive-non-teacher-actor"),
      403, "forbidden",
    );
  } finally {
    context.database.close();
  }
});

test("permanent removal requires a reason of at least 3 characters, but ordinary archiving does not require one", async () => {
  const context = fixture();
  try {
    const archivedNoReason = await act(context, ids.manager, false, "archive_attempt", { organizationId: ids.org, attemptId: context.attemptIds.shareable }, "archive-no-reason");
    assert.equal(archivedNoReason.ok, true);
    await expectDenied(
      act(context, ids.manager, false, "remove_attempt_permanently", { organizationId: ids.org, attemptId: context.attemptIds.shareable, reason: "hi" }, "remove-permanent-reason-too-short"),
      400, "validation", "A reason is required for permanent removal.",
    );
    await expectDenied(
      act(context, ids.manager, false, "remove_attempt_permanently", { organizationId: ids.org, attemptId: context.attemptIds.shareable }, "remove-permanent-reason-missing"),
      400, "validation", "A reason is required for permanent removal.",
    );
    const removed = await act(context, ids.manager, false, "remove_attempt_permanently", { organizationId: ids.org, attemptId: context.attemptIds.shareable, reason: "dup" }, "remove-permanent-reason-boundary-ok");
    assert.equal(removed.ok, true, "exactly 3 characters is the boundary and must be accepted");
  } finally {
    context.database.close();
  }
});

test("archiving upserts, restoring only affects an archived-and-not-yet-restored row, and permanent removal tombstones without deleting the attempt", async () => {
  const context = fixture();
  try {
    await act(context, ids.manager, false, "archive_attempt", { organizationId: ids.org, attemptId: context.attemptIds.shareable, reason: "first pass" }, "archive-first");
    await act(context, ids.manager, false, "archive_attempt", { organizationId: ids.org, attemptId: context.attemptIds.shareable, reason: "second pass" }, "archive-second");
    const archiveRows = context.database.prepare(
      "SELECT reason FROM organization_attempt_archives WHERE organization_id = ? AND attempt_id = ?",
    ).all(ids.org, context.attemptIds.shareable);
    assert.equal(archiveRows.length, 1, "archiving twice must upsert, not duplicate");
    assert.equal(archiveRows[0].reason, "second pass");

    const restored = await act(context, ids.manager, false, "restore_attempt", { organizationId: ids.org, attemptId: context.attemptIds.shareable }, "restore-first");
    assert.equal(restored.ok, true);
    const afterRestore = context.database.prepare(
      "SELECT restored_at FROM organization_attempt_archives WHERE organization_id = ? AND attempt_id = ?",
    ).get(ids.org, context.attemptIds.shareable);
    assert.ok(afterRestore.restored_at);
    // Restoring an already-restored row is a deliberate no-op (WHERE restored_at IS NULL);
    // the second attempt must leave the timestamp untouched.
    const firstRestoredAt = afterRestore.restored_at;
    context.database.exec("SELECT 1"); // no-op to keep timing distinct if ever needed
    await act(context, ids.manager, false, "restore_attempt", { organizationId: ids.org, attemptId: context.attemptIds.shareable }, "restore-second");
    assert.equal(
      context.database.prepare("SELECT restored_at FROM organization_attempt_archives WHERE organization_id = ? AND attempt_id = ?").get(ids.org, context.attemptIds.shareable).restored_at,
      firstRestoredAt,
    );

    const removed = await act(context, ids.manager, false, "remove_attempt_permanently", { organizationId: ids.org, attemptId: context.attemptIds.shareable, reason: "policy violation" }, "remove-permanent-effect");
    assert.equal(removed.ok, true);
    assert.equal(
      context.database.prepare("SELECT count(*) AS total FROM practice_attempts WHERE id = ?").get(context.attemptIds.shareable).total,
      1,
      "the attempt itself is never deleted -- only tombstoned from organisation view",
    );
    const tombstone = context.database.prepare(
      "SELECT student_user_id, reason FROM organization_attempt_tombstones WHERE organization_id = ? AND attempt_id = ?",
    ).get(ids.org, context.attemptIds.shareable);
    assert.equal(tombstone.student_user_id, ids.student);
    assert.equal(tombstone.reason, "policy violation");
    const [audit] = auditRows(context, "remove_attempt_permanently");
    assert.equal(audit.target_type, "attempt");
    assert.equal(JSON.parse(audit.metadata_json).reason, "policy violation");
  } finally {
    context.database.close();
  }
});

// ---------------------------------------------------------------------------
// reserve_seat / release_seat (1158-1194)
// ---------------------------------------------------------------------------

test("reserve_seat/release_seat's own id() labels name the organisation and the member for malformed ids", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "reserve_seat", { organizationId: "not-a-uuid", userId: ids.outsider, seatPoolId: "60000000-0000-4000-8000-000000000003" }, "reserve-malformed-org-id"),
      400, "validation", "Invalid organisation.",
    );
    await expectDenied(
      act(context, ids.manager, false, "release_seat", { organizationId: ids.org, userId: "not-a-uuid" }, "release-malformed-user-id"),
      400, "validation", "Invalid member.",
    );
  } finally {
    context.database.close();
  }
});

test("reserving or releasing a seat requires manage rights", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.teacher, false, "reserve_seat", { organizationId: ids.org, userId: ids.outsider, seatPoolId: "60000000-0000-4000-8000-000000000003" }, "reserve-forbidden"),
      403, "forbidden",
    );
  } finally {
    context.database.close();
  }
});

test("reserve_seat requires an active, unexpired pool with remaining capacity", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.manager, false, "reserve_seat", {
        organizationId: ids.org, userId: ids.outsider2, seatPoolId: "not-a-uuid",
      }, "reserve-malformed-pool-id"),
      400, "validation", "Invalid seat pool.",
    );
    await expectDenied(
      act(context, ids.manager, false, "reserve_seat", {
        organizationId: ids.org, userId: ids.outsider2, seatPoolId: "60000000-0000-4000-8000-000000000002",
      }, "reserve-expired-pool"),
      400, "validation", "Active seat pool not found.",
    );
    await expectDenied(
      act(context, ids.manager, false, "reserve_seat", {
        organizationId: ids.org, userId: ids.outsider2, seatPoolId: "60000000-0000-4000-8000-000000000001",
      }, "reserve-full-pool"),
      400, "validation", "No seats are available.",
    );
    const response = await act(context, ids.manager, false, "reserve_seat", {
      organizationId: ids.org, userId: ids.outsider2, seatPoolId: "60000000-0000-4000-8000-000000000003",
    }, "reserve-ok");
    assert.equal(response.ok, true);
    const allocation = context.database.prepare(
      "SELECT status FROM organization_seat_allocations WHERE organization_id = ? AND seat_pool_id = ? AND user_id = ?",
    ).get(ids.org, "60000000-0000-4000-8000-000000000003", ids.outsider2);
    assert.equal(allocation.status, "reserved");
    const [audit] = auditRows(context, "reserve_seat");
    assert.equal(audit.target_type, "seat");
    assert.equal(audit.target_id, ids.outsider2);
  } finally {
    context.database.close();
  }
});

test("release_seat marks the live allocation released", async () => {
  const context = fixture();
  try {
    const response = await act(context, ids.manager, false, "release_seat", { organizationId: ids.org, userId: ids.outsider }, "release-ok");
    assert.equal(response.ok, true);
    const allocation = context.database.prepare(
      "SELECT status, ends_at FROM organization_seat_allocations WHERE organization_id = ? AND seat_pool_id = ? AND user_id = ?",
    ).get(ids.org, "60000000-0000-4000-8000-000000000003", ids.outsider);
    assert.equal(allocation.status, "released");
    assert.ok(allocation.ends_at);
  } finally {
    context.database.close();
  }
});

// ---------------------------------------------------------------------------
// Unknown action (1196)
// ---------------------------------------------------------------------------

test("an unrecognised action is refused with a clear message", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.owner, false, "not_a_real_action", { organizationId: ids.org }, "unknown-action"),
      400, "validation", "Unknown organisation action.",
    );
  } finally {
    context.database.close();
  }
});

// ---------------------------------------------------------------------------
// cloudflareOrganizationCommand wrapper (1199-1236)
// ---------------------------------------------------------------------------

test("the command payload is bounded to 65,536 bytes of JSON", async () => {
  const context = fixture();
  try {
    await expectDenied(
      commands.cloudflareOrganizationCommand(
        context.user(ids.owner), false, "create_organization",
        { organizationName: "x".repeat(70_000) }, nextKey("payload-too-big"), context.bindings,
      ),
      400, "validation", "Invalid command data.",
    );
  } finally {
    context.database.close();
  }
});

test("a payload of exactly 65,536 bytes clears the size gate and reaches the command's own validation", async () => {
  const context = fixture();
  try {
    // Land precisely on the boundary rather than approximately over it -- the
    // gate is "greater than", so a same-size payload must fall through to
    // ordinary field validation, not be turned away as oversized.
    const overhead = JSON.stringify({ organizationName: "" }).length;
    const organizationName = "x".repeat(65_536 - overhead);
    assert.equal(JSON.stringify({ organizationName }).length, 65_536);
    await expectDenied(
      commands.cloudflareOrganizationCommand(
        context.user(ids.owner), false, "create_organization",
        { organizationName }, nextKey("payload-exact-boundary"), context.bindings,
      ),
      400, "validation", "Invalid organisation name.",
    );
  } finally {
    context.database.close();
  }
});

test("a replayed idempotency key returns the cached result without ever contending for the scope's lock", async () => {
  const context = fixture();
  try {
    const key = nextKey("replay-skips-lock");
    const payload = { organizationId: ids.org, userId: ids.student2 };
    const first = await commands.cloudflareOrganizationCommand(
      context.user(ids.manager), false, "suspend_member", payload, key, context.bindings,
    );
    assert.equal(first.ok, true);

    // A genuinely concurrent command on the same organisation, held by
    // somebody else and still live -- a real replay must short-circuit
    // before ever reaching acquireLock, so it must not collide with this.
    context.database.prepare(`
      INSERT INTO organization_command_locks (scope_key, owner_key, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(`organization:${ids.org}`, "someone-else:some-other-key", FAR_FUTURE, FIXTURE_NOW);

    const replay = await commands.cloudflareOrganizationCommand(
      context.user(ids.manager), false, "suspend_member", payload, key, context.bindings,
    );
    assert.equal(replay.ok, true);
  } finally {
    context.database.close();
  }
});

test("the lock scope is per-organisation for an org-scoped action, and per-actor for one with neither an organisation nor an application", async () => {
  const context = fixture();
  try {
    await act(context, ids.owner, false, "create_organization", { organizationName: "Scope Co" }, "scope-actor");
    const actorScoped = context.batches.find((batch) =>
      batch.some((statement) => statement.sql.includes("INSERT OR IGNORE INTO organization_command_locks")));
    const insert = actorScoped.find((statement) => statement.sql.includes("INSERT OR IGNORE INTO organization_command_locks"));
    assert.equal(insert.values[0], `actor:${ids.owner}`, "create_organization has no organisationId yet, so the lock must be actor-scoped");
    // The owner key must actually combine the actor and this call's own
    // idempotency key -- a constant here would make one caller's lock
    // indistinguishable from another's instead of just sharing a scope.
    assert.ok(
      insert.values[1].startsWith(`${ids.owner}:idem-scope-actor-`),
      `owner key must combine actor and idempotency key, got ${JSON.stringify(insert.values[1])}`,
    );

    context.batches.length = 0;
    await act(context, ids.student, false, "request_to_leave", { organizationId: ids.org }, "scope-org");
    context.batches.length = 0;
    await act(context, ids.student2, false, "request_to_leave", { organizationId: ids.org }, "scope-org-2");
    const orgScoped = context.batches.find((batch) =>
      batch.some((statement) => statement.sql.includes("INSERT OR IGNORE INTO organization_command_locks")));
    const orgInsert = orgScoped.find((statement) => statement.sql.includes("INSERT OR IGNORE INTO organization_command_locks"));
    assert.equal(orgInsert.values[0], `organization:${ids.org}`);
  } finally {
    context.database.close();
  }
});

test("the lock scope falls back to the application only when applicationId is actually a string, not merely present", async () => {
  const context = fixture();
  try {
    context.batches.length = 0;
    await expectDenied(
      act(context, ids.owner, false, "not_a_real_action", { applicationId: "app-42" }, "scope-application"),
      400, "validation", "Unknown organisation action.",
    );
    const appScoped = context.batches.find((batch) =>
      batch.some((statement) => statement.sql.includes("INSERT OR IGNORE INTO organization_command_locks")));
    const appInsert = appScoped.find((statement) => statement.sql.includes("INSERT OR IGNORE INTO organization_command_locks"));
    assert.equal(appInsert.values[0], "application:app-42", "a string applicationId with no organisation must scope the lock to that application");

    context.batches.length = 0;
    await expectDenied(
      act(context, ids.owner, false, "not_a_real_action", { applicationId: 42 }, "scope-application-non-string"),
      400, "validation", "Unknown organisation action.",
    );
    const actorScoped = context.batches.find((batch) =>
      batch.some((statement) => statement.sql.includes("INSERT OR IGNORE INTO organization_command_locks")));
    const actorInsert = actorScoped.find((statement) => statement.sql.includes("INSERT OR IGNORE INTO organization_command_locks"));
    assert.equal(actorInsert.values[0], `actor:${ids.owner}`, "a non-string applicationId must not be treated as one -- falls back to actor scope");
  } finally {
    context.database.close();
  }
});

test("a lock is still released after the command throws, so a later command is not blocked by it", async () => {
  const context = fixture();
  try {
    await expectDenied(
      act(context, ids.teacher, false, "delete_organization", { organizationId: ids.org, confirmationName: "Harbour Academy" }, "release-on-error-1"),
      403, "forbidden",
    );
    // If the lock survived the thrown error, this second, unrelated command
    // on the same organisation scope would now be wrongly refused as
    // "Another organisation change is still being saved."
    const response = await act(context, ids.student, false, "request_to_leave", { organizationId: ids.org }, "release-on-error-2");
    assert.equal(response.ok, true);
  } finally {
    context.database.close();
  }
});
