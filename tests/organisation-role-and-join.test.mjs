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
const cloudflareOrganizations = await load("lib", "cloudflare", "organizations.ts");

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

const now = "2026-08-15T04:00:00.000Z";
const earlier = "2026-08-01T04:00:00.000Z";
const later = "2026-08-20T04:00:00.000Z";

// Every id below is a distinct valid v4-shaped UUID so the id() validator in
// organization-commands.ts accepts it without complaint.
const ids = {
  organization: "21111111-1111-4111-8111-111111111111",
  owner: "60000000-0000-4000-8000-000000000001",
  manager: "60000000-0000-4000-8000-000000000002",
  teacher: "60000000-0000-4000-8000-000000000003",
  teacher2: "60000000-0000-4000-8000-000000000004",
  student: "60000000-0000-4000-8000-000000000005",
  noPlan: "60000000-0000-4000-8000-000000000006",
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
  for (const [key, id] of Object.entries(ids)) insertUser.run(id, `${key}@example.com`, now, now);

  database.prepare(`
    INSERT INTO organizations (
      id, application_id, name, slug, status, created_by,
      created_at, updated_at, join_code
    ) VALUES (?, NULL, 'Riverside Language School', NULL, 'active', ?, ?, ?, 'riversidejoincod')
  `).run(ids.organization, ids.owner, now, now);

  const insertMembership = database.prepare(`
    INSERT INTO organization_memberships (
      id, organization_id, user_id, role, status,
      share_future_history, share_pre_join_history, joined_at,
      created_at, updated_at, status_changed_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
  `);
  insertMembership.run("72000000-0000-4000-8000-000000000001", ids.organization, ids.owner, "owner", 1, 0, now, now, now, now);
  insertMembership.run("72000000-0000-4000-8000-000000000002", ids.organization, ids.manager, "manager", 1, 0, now, now, now, now);
  insertMembership.run("72000000-0000-4000-8000-000000000003", ids.organization, ids.teacher, "teacher", 0, 0, now, now, now, now);
  insertMembership.run("72000000-0000-4000-8000-000000000004", ids.organization, ids.teacher2, "teacher", 1, 0, now, now, now, now);
  // This student already shared their pre-join history — a real prior
  // consent, which a repeated "set to student" must not clobber.
  insertMembership.run("72000000-0000-4000-8000-000000000005", ids.organization, ids.student, "student", 1, 1, now, now, now, now);
  insertMembership.run("72000000-0000-4000-8000-000000000006", ids.organization, ids.noPlan, "teacher", 0, 0, now, now, now, now);

  const insertSubscription = database.prepare(`
    INSERT INTO subscriptions (
      id, user_id, provider, status, tier, verified_at, created_at, updated_at
    ) VALUES (?, ?, 'stripe', 'active', 'standard', ?, ?, ?)
  `);
  // Every account that might end up as (or become) a student needs an
  // eligible plan, since studentEligible() gates that regardless of role —
  // ids.noPlan deliberately gets none, to exercise that gate.
  insertSubscription.run("73000000-0000-4000-8000-000000000001", ids.teacher, now, now, now);
  insertSubscription.run("73000000-0000-4000-8000-000000000002", ids.teacher2, now, now, now);
  insertSubscription.run("73000000-0000-4000-8000-000000000003", ids.student, now, now, now);

  const insertAttempt = database.prepare(`
    INSERT INTO practice_attempts (
      id, user_id, module, test_id, test_title, submitted_at,
      score, score_out_of, band, feedback_summary,
      result_inline, result_object_key, result_sha256, result_bytes,
      created_at, updated_at
    ) VALUES (
      ?, ?, 'listening', 'test-1', 'Listening test', ?, 30, 40, 7, 'Solid work',
      '{}', NULL, '${"0".repeat(64)}', 2,
      ?, ?
    )
  `);
  /*
    Two attempts for teacher2, on either side of the day they joined. A
    converted student shares future history and not pre-join history — the
    same split every ordinary joiner gets — so the earlier one must stay
    private and the later one must surface.
  */
  insertAttempt.run("74000000-0000-4000-8000-000000000001", ids.teacher2, earlier, now, now);
  insertAttempt.run("74000000-0000-4000-8000-000000000002", ids.teacher2, later, now, now);

  return {
    database,
    bindings: { db: runtimeD1(database), files: {} },
    user(id) { return { id, email: `${id}@example.com` }; },
  };
}

let key = 0;
function nextKey(label) {
  key += 1;
  return `${label}-${key}`;
}

// ---------------------------------------------------------------------------
// Change 1: a manager can set the student role after somebody has joined,
// without exposing history the person never agreed to share.
// ---------------------------------------------------------------------------

test("a manager can change a teacher into a student", async () => {
  const context = fixture();
  try {
    const response = await commands.cloudflareOrganizationCommand(
      context.user(ids.manager), false, "change_member_role",
      { organizationId: ids.organization, userId: ids.teacher2, role: "student" },
      nextKey("teacher-to-student"), context.bindings,
    );
    assert.equal(response.ok, true);
    const row = context.database.prepare(
      "SELECT role FROM organization_memberships WHERE organization_id = ? AND user_id = ?",
    ).get(ids.organization, ids.teacher2);
    assert.equal(row.role, "student");
  } finally {
    context.database.close();
  }
});

test("a converted student starts sharing exactly as a joining student does", async () => {
  const context = fixture();
  try {
    await commands.cloudflareOrganizationCommand(
      context.user(ids.manager), false, "change_member_role",
      { organizationId: ids.organization, userId: ids.teacher2, role: "student" },
      nextKey("teacher-to-student-flags"), context.bindings,
    );
    const row = context.database.prepare(
      "SELECT share_future_history, share_pre_join_history FROM organization_memberships WHERE organization_id = ? AND user_id = ?",
    ).get(ids.organization, ids.teacher2);
    assert.equal(row.share_future_history, 1);
    assert.equal(row.share_pre_join_history, 0);
  } finally {
    context.database.close();
  }
});

test("a converted student's work is shared from the day they joined, and not before it", async () => {
  const context = fixture();
  try {
    await commands.cloudflareOrganizationCommand(
      context.user(ids.manager), false, "change_member_role",
      { organizationId: ids.organization, userId: ids.teacher2, role: "student" },
      nextKey("teacher-to-student-visibility"), context.bindings,
    );
    // change_member_role revokes any assignment the converted member held as
    // a teacher; give them a fresh one as a student, the shape a manager
    // would actually create next, so the assignment-scoped teacher view has
    // something to look at.
    context.database.prepare(`
      INSERT INTO teacher_student_assignments (
        id, organization_id, teacher_user_id, student_user_id, assigned_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run("75000000-0000-4000-8000-000000000001", ids.organization, ids.teacher, ids.teacher2, ids.manager, now);

    const teacherPortal = await cloudflareOrganizations.cloudflareOrganizationPortal(
      context.user(ids.teacher), false, null, context.bindings,
    );
    const seen = teacherPortal.students?.find((student) => student.userId === ids.teacher2);
    assert.ok(seen, "the converted student must still appear on the roster");
    /*
      One of teacher2's two attempts predates their membership and one follows
      it. Exactly the later one counts: converting somebody to a student shares
      what they do from the day they joined onward, and never reaches back into
      the practice they did before the organisation existed for them.
    */
    assert.equal(seen.completedAttempts, 1, "work from after joining is shared");
    assert.equal(seen.lastActiveAt, later, "and it is the later attempt, not the earlier one");
  } finally {
    context.database.close();
  }
});

test("a member who was already a student keeps their existing sharing values when set to student again", async () => {
  const context = fixture();
  try {
    const response = await commands.cloudflareOrganizationCommand(
      context.user(ids.manager), false, "change_member_role",
      { organizationId: ids.organization, userId: ids.student, role: "student" },
      nextKey("student-stays-student"), context.bindings,
    );
    assert.equal(response.ok, true);
    const row = context.database.prepare(
      "SELECT share_future_history, share_pre_join_history FROM organization_memberships WHERE organization_id = ? AND user_id = ?",
    ).get(ids.organization, ids.student);
    assert.equal(row.share_future_history, 1, "existing consent must not be reset");
    assert.equal(row.share_pre_join_history, 1, "existing consent must not be reset");
  } finally {
    context.database.close();
  }
});

test("studentEligible is still enforced when converting somebody into a student", async () => {
  const context = fixture();
  try {
    await assert.rejects(
      commands.cloudflareOrganizationCommand(
        context.user(ids.manager), false, "change_member_role",
        { organizationId: ids.organization, userId: ids.noPlan, role: "student" },
        nextKey("no-plan-to-student"), context.bindings,
      ),
      (error) => error instanceof commands.OrganizationCommandError
        && error.status === 400 && error.message === "The student needs an eligible plan or seat.",
    );
    const row = context.database.prepare(
      "SELECT role FROM organization_memberships WHERE organization_id = ? AND user_id = ?",
    ).get(ids.organization, ids.noPlan);
    assert.equal(row.role, "teacher", "the target must be untouched");
  } finally {
    context.database.close();
  }
});

test("an owner still cannot be touched by a manager, including a conversion to student", async () => {
  const context = fixture();
  try {
    await assert.rejects(
      commands.cloudflareOrganizationCommand(
        context.user(ids.manager), false, "change_member_role",
        { organizationId: ids.organization, userId: ids.owner, role: "student" },
        nextKey("owner-untouchable"), context.bindings,
      ),
      (error) => error instanceof commands.OrganizationCommandError
        && error.status === 400 && error.message === "Only BandUp can manage an owner.",
    );
    const row = context.database.prepare(
      "SELECT role FROM organization_memberships WHERE organization_id = ? AND user_id = ?",
    ).get(ids.organization, ids.owner);
    assert.equal(row.role, "owner");
  } finally {
    context.database.close();
  }
});

// ---------------------------------------------------------------------------
// UI: a manager who converts someone to student must not read the resulting
// silence as broken.
// ---------------------------------------------------------------------------

test("a student with sharing off is marked as not sharing yet on the roster", () => {
  const portal = readFileSync(
    join(process.cwd(), "components", "organization", "OrganizationPortal.tsx"),
    "utf8",
  );
  const groups = portal.slice(portal.indexOf("function TeamGroups"), portal.indexOf("function JoinCodeCard"));
  assert.match(groups, /Not sharing yet/);
  assert.match(groups, /!student\.shareFutureHistory && !student\.sharePreJoinHistory/);
});

// ---------------------------------------------------------------------------
// Change 3: the role change is a visible pill on the member card itself,
// not something a manager has to open a disclosure to find.
//
// Asserted against the source, as the other rendering test in this file
// does, because the component needs a signed-in portal to mount.
// ---------------------------------------------------------------------------

test("the role control sits on the card itself, outside any <details>, and reuses MemberRolePicker", () => {
  const portal = readFileSync(
    join(process.cwd(), "components", "organization", "OrganizationPortal.tsx"),
    "utf8",
  );
  const groups = portal.slice(portal.indexOf("function TeamGroups"), portal.indexOf("function JoinCodeCard"));
  const detailsBlocks = [...groups.matchAll(/<details[\s\S]*?<\/details>/g)].map((match) => match[0]);

  // Every MemberRolePicker rendered in the roster must sit outside every
  // <details> block — on the card, not behind a disclosure.
  const rolePickerCalls = [...groups.matchAll(/<MemberRolePicker\b/g)];
  assert.ok(rolePickerCalls.length >= 3, "a role pill must be drawn for leaders, teachers and students");
  for (const block of detailsBlocks) {
    assert.doesNotMatch(block, /<MemberRolePicker\b/, "the role control must not live inside a details disclosure");
  }

  // It is the same control and the same command, not a second code path.
  assert.match(groups, /<MemberRolePicker member=\{leader\}/);
  assert.match(groups, /<MemberRolePicker member=\{teacher\}/);
  assert.match(groups, /<MemberRolePicker member=\{student\}/);

  // The disclosure that remains is for the destructive, rare actions only —
  // that summary text lives in MemberManagement, defined just above TeamGroups.
  const management = portal.slice(portal.indexOf("function MemberManagement"), portal.indexOf("function TeamGroups"));
  assert.match(management, /Suspend or remove member/);
  assert.doesNotMatch(management, /Manage member</);
  assert.doesNotMatch(management, /<MemberRolePicker\b/, "the role picker must not remain inside MemberManagement");
});

test("an owner row draws no role control, since the server refuses every action against one", () => {
  const portal = readFileSync(
    join(process.cwd(), "components", "organization", "OrganizationPortal.tsx"),
    "utf8",
  );
  const groups = portal.slice(portal.indexOf("function TeamGroups"), portal.indexOf("function JoinCodeCard"));
  const leadersSection = groups.slice(groups.indexOf("Owners and managers"), groups.indexOf("organization-team-pairing-grid"));
  // The leader row only draws MemberRolePicker for a manager; an owner falls
  // through to the plain, unclickable StatusPill.
  assert.match(leadersSection, /leader\.role === "manager" \? \(\s*<MemberRolePicker/);
  assert.match(leadersSection, /<StatusPill>\{titleCase\(leader\.role\)\}<\/StatusPill>/);
});

// ---------------------------------------------------------------------------
// Change 2: one search field for joining, taking either a name or a code.
// ---------------------------------------------------------------------------

const codePattern = /^[0-9a-f]{16}$/;

test("a 16-character hex value is recognised as a join code shape", () => {
  assert.equal(codePattern.test("harbourjoincode1"), false, "17 chars must not match");
  assert.equal(codePattern.test("a1b2c3d4e5f60718"), true);
  assert.equal(codePattern.test("Riverside School"), false);
  assert.equal(codePattern.test("not-hex-at-all!!"), false);
});

test("the join form tries the value as a code first, then falls back to a name search on failure", () => {
  const forms = readFileSync(join(process.cwd(), "components/organization/OrganizationForms.tsx"), "utf8");
  const joinForm = forms.slice(
    forms.indexOf("export function JoinOrganizationForm"),
    forms.indexOf("export function OrganizationCreateForm"),
  );
  // One input, one submit button, no separate code disclosure.
  assert.doesNotMatch(joinForm, /<details|Have an organisation code/);
  assert.match(joinForm, /Organisation name or code/);
  // Shape decides the branch; code first, then the fallback search.
  assert.match(joinForm, /codePattern\.test\(clean\.toLowerCase\(\)\)/);
  assert.match(joinForm, /request_to_join["'{,][\s\S]*code: clean/);
  assert.match(joinForm, /await searchByName\(clean\)/);
  assert.match(joinForm, /shareFutureHistoryConsent: true/);
});

test("the join card keeps the same GlassSection shell as the create card beside it", () => {
  const forms = readFileSync(join(process.cwd(), "components/organization/OrganizationForms.tsx"), "utf8");
  const joinForm = forms.slice(
    forms.indexOf("export function JoinOrganizationForm"),
    forms.indexOf("export function OrganizationCreateForm"),
  );
  assert.match(joinForm, /<GlassSection/);
});
