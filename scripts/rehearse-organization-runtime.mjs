#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler";

register("../tests/alias-resolve.mjs", import.meta.url);

const epoch = "2026-08-12T00:00:00.000Z";
const persist = await mkdtemp(join(tmpdir(), "bandup-organization-runtime-"));
let proxy;

try {
  proxy = await getPlatformProxy({
    configPath: "wrangler.preview.jsonc",
    persist: { path: persist },
    remoteBindings: false,
  });
  const bindings = {
    db: proxy.env.BANDUP_DB,
    files: proxy.env.BANDUP_FILES,
  };
  assert.ok(bindings.db && bindings.files, "preview bindings did not load");
  const migrationDirectory = join(process.cwd(), "cloudflare", "migrations");
  const migrations = (await readdir(migrationDirectory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  for (const migration of migrations) {
    const source = await readFile(join(migrationDirectory, migration), "utf8");
    const executable = source.replace(/^PRAGMA foreign_keys\s*=\s*ON;\s*/m, "");
    for (const statement of unstable_splitSqlQuery(executable)) {
      const clean = statement.trim();
      if (clean) await bindings.db.prepare(clean).run();
    }
  }

  const commands = await import("../lib/cloudflare/organization-commands.ts");
  const organizations = await import("../lib/cloudflare/organizations.ts");
  const learnerData = await import("../lib/cloudflare/learner-data.ts");
  const owner = { id: "10000000-0000-4000-8000-000000000001", email: "owner@runtime.invalid" };
  const teacher = { id: "10000000-0000-4000-8000-000000000002", email: "teacher@runtime.invalid" };
  const student = { id: "10000000-0000-4000-8000-000000000003", email: "student@runtime.invalid" };
  const outsider = { id: "10000000-0000-4000-8000-000000000004", email: "outsider@runtime.invalid" };
  let sequence = 0;
  const command = (user, platformAdmin, action, payload) => commands.cloudflareOrganizationCommand(
    user,
    platformAdmin,
    action,
    payload,
    `runtime-${String(++sequence).padStart(5, "0")}`,
    bindings,
  );

  const submitted = await command(owner, true, "submit_application", {
    organizationName: "Runtime Academy",
    country: "Hong Kong",
    contactEmail: owner.email,
    applicantRole: "Owner",
    estimatedStudents: 50,
  });
  assert.deepEqual(submitted, { ok: true });
  const afterSubmit = await organizations.cloudflareOrganizationPortal(owner, true, null, bindings);
  const applicationId = afterSubmit.applications?.[0]?.id;
  assert.ok(applicationId);
  const storedApplication = await bindings.db.prepare(
    "SELECT purpose FROM organization_applications WHERE id = ?",
  ).bind(applicationId).first();
  assert.equal(storedApplication?.purpose, "Organization workspace request.");
  const approved = await command(owner, true, "decide_application", {
    applicationId,
    approve: true,
    note: "Runtime rehearsal",
  });
  assert.deepEqual(approved, { ok: true });
  const afterApproval = await organizations.cloudflareOrganizationPortal(owner, true, null, bindings);
  const organizationId = afterApproval.memberships[0]?.organization.id;
  assert.ok(organizationId);

  await bindings.db.prepare(`
    INSERT INTO app_users (id, email, role, created_at, updated_at)
    VALUES (?, ?, 'user', ?, ?)
  `).bind(
    student.id, student.email, "2026-08-12T00:00:00.000Z",
    "2026-08-12T00:00:00.000Z",
  ).run();
  assert.equal(
    await learnerData.claimCloudflareUsername(student, "curious-otter-321", undefined, bindings),
    "ok",
  );
  assert.equal(
    await learnerData.emailForCloudflareUsername("CURIOUS-OTTER-321", bindings),
    student.email,
  );
  assert.equal(
    await learnerData.cloudflareUsernameMatches(student.id, "curious-otter-321", bindings),
    true,
  );
  assert.equal(
    await learnerData.cloudflareUsernameMatches(student.id, "different-name-999", bindings),
    false,
  );
  await assert.rejects(
    bindings.db.prepare(`
      UPDATE usernames SET username = 'support' WHERE user_id = ?
    `).bind(student.id).run(),
    /invalid or reserved username/,
  );
  await bindings.db.prepare(`
    INSERT INTO subscriptions (
      id, user_id, provider, status, tier, current_period_end,
      verified_at, created_at, updated_at
    ) VALUES (?, ?, 'stripe', 'active', 'plus', ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(), student.id, "2027-08-12T00:00:00.000Z",
    "2026-08-12T00:00:00.000Z", "2026-08-12T00:00:00.000Z",
    "2026-08-12T00:00:00.000Z",
  ).run();
  const code = await bindings.db.prepare(
    "SELECT join_code FROM organizations WHERE id = ?",
  ).bind(organizationId).first();
  assert.ok(code?.join_code, `join code missing for ${organizationId}: ${JSON.stringify(code)}`);

  await command(student, false, "request_to_join", {
    code: code.join_code,
    shareFutureHistoryConsent: true,
  });
  const ownerPortal = await organizations.cloudflareOrganizationPortal(owner, true, organizationId, bindings);
  const joinRequest = ownerPortal.requests?.find((request) => request.kind === "join");
  assert.ok(joinRequest);
  await command(owner, true, "decide_join_request", {
    requestId: joinRequest.id,
    approve: true,
  });

  await learnerData.ensureCloudflareUser(teacher, bindings);
  const inviteToken = "runtime-teacher-invitation-token-0001";
  const invitation = await command(owner, true, "invite_member", {
    organizationId,
    userId: teacher.id,
    role: "teacher",
    token: inviteToken,
  });
  assert.ok(invitation.invitation?.requestId);
  const invitationNotifications = Number((await bindings.db.prepare(`
    SELECT count(*) AS total FROM user_notifications
     WHERE recipient_user_id = ? AND kind = 'organization_invitation'
  `).bind(teacher.id).first())?.total ?? 0);
  assert.equal(invitationNotifications, 1);
  const staleInviteToken = "runtime-teacher-invitation-token-0002";
  await assert.rejects(
    command(owner, true, "invite_member", {
      organizationId,
      userId: teacher.id,
      role: "manager",
      token: staleInviteToken,
    }),
    /already awaiting a response/i,
  );
  assert.equal(Number((await bindings.db.prepare(`
    SELECT count(*) AS total FROM user_notifications
     WHERE recipient_user_id = ? AND kind = 'organization_invitation'
  `).bind(teacher.id).first())?.total ?? 0), invitationNotifications);
  await command(teacher, false, "accept_invitation", {
    requestId: invitation.invitation.requestId,
    shareFutureHistoryConsent: true,
  });
  const teacherMembership = await bindings.db.prepare(`
    SELECT role, status FROM organization_memberships
     WHERE organization_id = ? AND user_id = ?
  `).bind(organizationId, teacher.id).first();
  assert.deepEqual(teacherMembership, { role: "teacher", status: "active" });

  await command(owner, true, "assign_teacher_batch", {
    organizationId,
    teacherUserId: teacher.id,
    studentUserIds: [student.id],
  });
  await command(teacher, false, "assign_practice", {
    organizationId,
    studentUserId: student.id,
    skill: "reading",
    testId: "reading-1",
    note: "Complete the first reading paper.",
  });
  const testResult = {
    module: "reading",
    testId: "reading-1",
    testTitle: "Runtime reading paper",
    raw: 8,
    total: 10,
    band: 7,
    date: new Date().toISOString(),
    review: {
      kind: "objective",
      questions: [{ id: "q1", prompt: "Runtime question", answer: "A" }],
      answers: { q1: "A" },
    },
  };
  assert.equal(await organizations.syncCloudflareOrganizationAttempts(
    student,
    [testResult],
    "runtime-sync-000001",
    bindings,
  ), true);

  const teacherPortal = await organizations.cloudflareOrganizationPortal(teacher, false, organizationId, bindings);
  assert.equal(teacherPortal.students?.length, 1);
  assert.equal(teacherPortal.students?.[0]?.userId, student.id);
  const history = await organizations.cloudflareOrganizationStudentHistory(
    teacher,
    false,
    student.id,
    bindings,
  );
  assert.equal(history.attempts.length, 1);
  assert.equal(history.attempts[0]?.band, 7);
  assert.ok(history.attempts[0]?.review);
  assert.equal(await organizations.cloudflareHistoryClearAllowed(student, bindings), false);
  await command(teacher, false, "save_teacher_feedback", {
    organizationId,
    attemptId: history.attempts[0].id,
    message: "Strong evidence selection. Review the final inference once more.",
  });

  const learningWorkBeforeDeletion = await bindings.db.prepare(`
    SELECT
      (SELECT count(*) FROM organization_practice_assignments
        WHERE student_user_id = ?) AS assignments,
      (SELECT count(*) FROM organization_teacher_feedback
        WHERE student_user_id = ?) AS feedback,
      (SELECT count(*) FROM user_notifications
        WHERE recipient_user_id = ? AND kind IN ('practice_assigned', 'teacher_feedback'))
        AS student_notifications,
      (SELECT count(*) FROM user_notifications
        WHERE recipient_user_id = ? AND actor_user_id = ? AND kind = 'assignment_completed')
        AS teacher_notifications
  `).bind(student.id, student.id, student.id, teacher.id, student.id).first();
  assert.equal(Number(learningWorkBeforeDeletion?.assignments), 1);
  assert.equal(Number(learningWorkBeforeDeletion?.feedback), 1);
  assert.equal(Number(learningWorkBeforeDeletion?.student_notifications), 2);
  assert.equal(Number(learningWorkBeforeDeletion?.teacher_notifications), 1);

  // Membership-time changes are requests: the value remains unchanged until
  // a permitted manager/teacher approves the request.
  await command(student, false, "set_prior_history_sharing", {
    organizationId,
    share: true,
  });
  let sharing = await bindings.db.prepare(
    "SELECT share_pre_join_history FROM organization_memberships WHERE organization_id = ? AND user_id = ?",
  ).bind(organizationId, student.id).first();
  assert.equal(Number(sharing?.share_pre_join_history), 0);
  const accessPortal = await organizations.cloudflareOrganizationPortal(owner, true, organizationId, bindings);
  const accessRequest = accessPortal.requests?.find(
    (request) => request.kind === "history_access_change" && request.status === "pending",
  );
  assert.ok(accessRequest);
  await command(owner, true, "decide_access_request", { requestId: accessRequest.id, approve: true });
  sharing = await bindings.db.prepare(
    "SELECT share_pre_join_history FROM organization_memberships WHERE organization_id = ? AND user_id = ?",
  ).bind(organizationId, student.id).first();
  assert.equal(Number(sharing?.share_pre_join_history), 1);

  await command(student, false, "request_access_change", {
    organizationId,
    scope: "future",
    share: false,
  });
  const teacherAccessPortal = await organizations.cloudflareOrganizationPortal(
    teacher,
    false,
    organizationId,
    bindings,
  );
  const futureAccessRequest = teacherAccessPortal.requests?.find(
    (request) => request.kind === "history_access_change"
      && request.status === "pending"
      && request.note === "scope:future",
  );
  assert.ok(futureAccessRequest, "assigned teacher could not see the future-history request");
  await command(teacher, false, "decide_access_request", {
    requestId: futureAccessRequest.id,
    approve: true,
  });
  const futureSharing = await bindings.db.prepare(
    "SELECT share_future_history FROM organization_memberships WHERE organization_id = ? AND user_id = ?",
  ).bind(organizationId, student.id).first();
  assert.equal(Number(futureSharing?.share_future_history), 0);

  await assert.rejects(
    organizations.cloudflareOrganizationStudentHistory(outsider, false, student.id, bindings),
    /Student not found/,
  );
  await assert.rejects(
    command(teacher, false, "remove_attempt_permanently", {
      organizationId,
      attemptId: history.attempts[0].id,
      reason: "Teacher must not permanently remove attempts",
    }),
    /Not permitted/,
  );
  await command(teacher, false, "archive_attempt", {
    organizationId,
    attemptId: history.attempts[0].id,
    reason: "Runtime archive",
  });
  await command(owner, true, "remove_attempt_permanently", {
    organizationId,
    attemptId: history.attempts[0].id,
    reason: "Runtime privacy invariant",
  });

  await command(student, false, "request_to_leave", { organizationId, note: "Runtime leave" });
  const refreshed = await organizations.cloudflareOrganizationPortal(owner, true, organizationId, bindings);
  const leaveRequest = refreshed.requests?.find((request) => request.kind === "leave" && request.status === "pending");
  assert.ok(leaveRequest);
  await command(owner, true, "decide_leave_request", { requestId: leaveRequest.id, approve: true });
  assert.equal(await organizations.cloudflareHistoryClearAllowed(student, bindings), true);
  const removedMembership = await bindings.db.prepare(
    "SELECT status, removed_at FROM organization_memberships WHERE organization_id = ? AND user_id = ?",
  ).bind(organizationId, student.id).first();
  assert.equal(removedMembership?.status, "removed");
  assert.ok(removedMembership?.removed_at);
  await command(student, false, "set_prior_history_sharing", { organizationId, share: false });
  const formerPortal = await organizations.cloudflareOrganizationPortal(student, false, organizationId, bindings);
  assert.equal(formerPortal.memberships[0]?.status, "removed");
  assert.equal(formerPortal.memberships[0]?.sharePreJoinHistory, false);

  const audit = await bindings.db.prepare(
    "SELECT count(*) AS total FROM organization_audit_log",
  ).first();
  const receipts = await bindings.db.prepare(
    "SELECT count(*) AS total FROM organization_command_receipts",
  ).first();
  assert.ok(Number(audit?.total) >= 10);
  assert.ok(Number(receipts?.total) >= 10);

  // Account deletion rehearsal: the durable Auth-start marker is written
  // before the simulated Supabase success. Everything before that marker is
  // reversible; everything after it must be retryable and retain immutable
  // organization evidence.
  const deletion = await import("../lib/cloudflare/account-deletion.ts");
  const learner = await import("../lib/cloudflare/learner-data.ts");
  const avatarKey = `private/avatars/${student.id}/fixture.webp`;
  const orphanAvatarKey = `private/avatars/${student.id}/superseded.webp`;
  const progressKey = `private/progress/ielts-prep-v1/${student.id}/fixture.json`;
  await bindings.files.put(avatarKey, "avatar");
  await bindings.files.put(orphanAvatarKey, "orphan");
  await bindings.files.put(progressKey, "progress");
  await bindings.db.prepare(`
    INSERT INTO learner_profiles (user_id, display_name, avatar_object_key, updated_at)
    VALUES (?, 'Runtime student', ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      display_name = excluded.display_name,
      avatar_object_key = excluded.avatar_object_key,
      updated_at = excluded.updated_at
  `).bind(student.id, avatarKey, epoch).run();
  await bindings.db.prepare(`
    INSERT INTO progress_snapshots (
      user_id, store_key, payload_inline, payload_object_key, payload_sha256,
      payload_bytes, created_at, updated_at
    ) VALUES (?, 'ielts-prep-v1', NULL, ?, ?, 8, ?, ?)
  `).bind(student.id, progressKey, "a".repeat(64), epoch, epoch).run();

  const migrationRun = "90000000-0000-4000-8000-000000000099";
  await bindings.db.prepare(`
    INSERT INTO data_migration_runs (
      id, source_system, target_system, mode, status, started_at, completed_at
    ) VALUES (?, 'supabase', 'cloudflare-d1-r2', 'copy', 'complete', ?, ?)
  `).bind(migrationRun, epoch, epoch).run();
  await bindings.db.prepare(`
    INSERT INTO data_migration_checkpoints (
      run_id, table_name, source_cursor, source_count, copied_count,
      verified_count, checksum, recorded_at
    ) VALUES (?, 'profiles', '', 1, 1, 1, ?, ?)
  `).bind(migrationRun, "b".repeat(64), epoch).run();
  await bindings.db.prepare(`
    INSERT INTO data_migration_source_rows (
      run_id, table_name, source_id, source_inline, source_sha256,
      source_bytes, recorded_at, subject_user_ids_json
    ) VALUES (?, 'profiles', ?, '{}', ?, 2, ?, ?)
  `).bind(
    migrationRun,
    student.id,
    "c".repeat(64),
    epoch,
    JSON.stringify([student.id]),
  ).run();
  await bindings.db.prepare(`
    INSERT INTO data_migration_row_map (
      run_id, table_name, source_id, target_id, row_sha256,
      recorded_at, subject_user_ids_json
    ) VALUES (?, 'profiles', ?, ?, ?, ?, ?)
  `).bind(
    migrationRun,
    student.id,
    student.id,
    "d".repeat(64),
    epoch,
    JSON.stringify([student.id]),
  ).run();

  const auditBeforeDeletion = Number((await bindings.db.prepare(
    "SELECT count(*) AS total FROM organization_audit_log",
  ).first())?.total ?? 0);
  const orgTombstonesBeforeDeletion = Number((await bindings.db.prepare(
    "SELECT count(*) AS total FROM organization_attempt_tombstones",
  ).first())?.total ?? 0);
  assert.ok(orgTombstonesBeforeDeletion >= 1);

  const prepared = await deletion.prepareCloudflareAccountDeletion(student, bindings);
  assert.equal(prepared.state, "prepared");
  await assert.rejects(
    learner.ensureCloudflareUser(student, bindings),
    /deletion is already in progress/i,
  );
  const authStarted = await deletion.beginCloudflareAccountAuthDeletion(
    student.id,
    prepared.operationId,
    bindings,
  );
  assert.equal(authStarted.state, "auth_delete_started");
  const deleted = await deletion.completeCloudflareAccountDeletion(
    student.id,
    prepared.operationId,
    bindings,
  );
  assert.deepEqual(deleted, { complete: true, state: "complete" });

  const privacy = await bindings.db.prepare(`
    SELECT
      (SELECT state FROM account_deletion_tombstones WHERE user_id = ?) AS deletion_state,
      (SELECT count(*) FROM account_deletion_objects WHERE user_id = ?) AS object_manifest,
      (SELECT count(*) FROM learner_profiles WHERE user_id = ?) AS profiles,
      (SELECT count(*) FROM progress_snapshots WHERE user_id = ?) AS progress,
      (SELECT count(*) FROM subscriptions WHERE user_id = ?) AS subscriptions,
      (SELECT count(*) FROM practice_attempts WHERE user_id = ?) AS attempts,
      (SELECT count(*) FROM organization_memberships WHERE user_id = ?) AS memberships,
      (SELECT count(*) FROM organization_practice_assignments
        WHERE student_user_id = ?) AS practice_assignments,
      (SELECT count(*) FROM organization_teacher_feedback
        WHERE student_user_id = ?) AS teacher_feedback,
      (SELECT count(*) FROM user_notifications
        WHERE recipient_user_id = ?) AS received_notifications,
      (SELECT count(*) FROM user_notifications
        WHERE recipient_user_id = ? AND kind = 'assignment_completed'
          AND actor_user_id IS NULL) AS anonymized_sent_notifications,
      (SELECT count(*) FROM data_migration_source_rows
        WHERE run_id = ? AND source_id = ?) AS source_rows,
      (SELECT count(*) FROM data_migration_row_map
        WHERE run_id = ? AND source_id = ?) AS row_maps,
      (SELECT count(*) FROM data_migration_checkpoints WHERE run_id = ?) AS checkpoints,
      (SELECT count(*) FROM organizations WHERE id = ?) AS organizations,
      (SELECT count(*) FROM organization_audit_log) AS audit_rows,
      (SELECT count(*) FROM organization_attempt_tombstones) AS org_tombstones,
      (SELECT count(*) FROM app_users
        WHERE id = ? AND email IS NULL AND deleted_at IS NOT NULL) AS scrubbed_user
  `).bind(
    student.id, student.id, student.id, student.id, student.id, student.id,
    student.id, student.id, student.id, student.id, teacher.id,
    migrationRun, student.id, migrationRun, student.id, migrationRun,
    organizationId, student.id,
  ).first();
  assert.equal(privacy?.deletion_state, "complete");
  for (const field of [
    "object_manifest", "profiles", "progress", "subscriptions", "attempts",
    "memberships", "practice_assignments", "teacher_feedback",
    "received_notifications", "source_rows", "row_maps",
  ]) assert.equal(Number(privacy?.[field]), 0, `${field} was not purged`);
  assert.equal(Number(privacy?.anonymized_sent_notifications), 1);
  assert.equal(Number(privacy?.checkpoints), 1);
  assert.equal(Number(privacy?.organizations), 1);
  assert.equal(Number(privacy?.audit_rows), auditBeforeDeletion);
  assert.equal(Number(privacy?.org_tombstones), orgTombstonesBeforeDeletion);
  assert.equal(Number(privacy?.scrubbed_user), 1);
  assert.equal(await bindings.files.head(avatarKey), null);
  assert.equal(await bindings.files.head(orphanAvatarKey), null);
  assert.equal(await bindings.files.head(progressKey), null);
  await assert.rejects(
    learner.ensureCloudflareUser(student, bindings),
    /deletion is already in progress/i,
  );

  process.stdout.write(JSON.stringify({
    organizationId,
    studentsVisibleToTeacher: teacherPortal.students?.length,
    storedAttempts: history.attempts.length,
    auditRows: Number(audit?.total),
    commandReceipts: Number(receipts?.total),
    accountDeletion: privacy?.deletion_state,
    retainedAuditRows: Number(privacy?.audit_rows),
  }) + "\n");
} finally {
  await proxy?.dispose();
  await rm(persist, { recursive: true, force: true });
}
