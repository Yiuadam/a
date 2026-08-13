import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const sql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0017_organizations.sql"),
  "utf8",
);
const batchSql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0018_organization_batch_assignments.sql"),
  "utf8",
);
const adminConsentSql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0019_organization_admin_context_and_consent.sql"),
  "utf8",
);
const formerConsentSql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0020_organization_former_member_consent.sql"),
  "utf8",
);
const invitationSafetySql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0024_account_bound_organization_invitations.sql"),
  "utf8",
);

test("organization tables are private and exposed only through fixed service RPCs", () => {
  for (const table of [
    "organization_applications",
    "organizations",
    "organization_memberships",
    "teacher_student_assignments",
    "organization_requests",
    "practice_attempts",
    "organization_attempt_archives",
    "organization_attempt_tombstones",
    "organization_audit_log",
  ]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(sql, /revoke all on table public\.organization_applications[\s\S]*from public, anon, authenticated/);
  for (const signature of [
    "organization_portal\\(uuid, boolean\\)",
    "organization_student_history\\(uuid, boolean, uuid\\)",
    "organization_sync_attempts\\(uuid, jsonb, text\\)",
    "organization_command\\(uuid, boolean, text, jsonb, text\\)",
  ]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${signature}[\\s\\S]*grant execute on function public\\.${signature} to service_role`));
  }
  assert.doesNotMatch(sql, /grant (?:select|insert|update|delete|all)[^;]+to (?:anon|authenticated)/i);
});

test("database enforces organization roles, states, student entitlement and teacher assignment", () => {
  assert.match(sql, /role in \('owner', 'manager', 'teacher', 'student'\)/);
  assert.match(sql, /status in \('invited', 'pending', 'active', 'leave_requested', 'suspended', 'removed'\)/);
  assert.match(sql, /s\.tier in \('standard', 'plus', 'pro'\)/);
  assert.match(sql, /organization_seat_allocations[\s\S]*organization_seat_pools/);
  assert.match(sql, /create trigger organization_memberships_entitlement/);
  assert.match(sql, /public\.organization_is_assigned\(p_actor, [^)]+, [^)]+\)/);
  assert.match(sql, /v_role = 'teacher' and public\.organization_is_assigned/);
});

test("practice history keeps exact results and organization deletion cannot delete learner source", () => {
  assert.match(sql, /payload\s+jsonb not null/);
  assert.match(sql, /Exact ModuleResult JSON is retained/);
  assert.match(sql, /'result', a\.payload/);
  assert.match(sql, /create table if not exists public\.organization_attempt_tombstones/);
  assert.match(sql, /create trigger organization_attempt_tombstones_immutable/);
  assert.doesNotMatch(sql, /delete\s+from\s+public\.practice_attempts/i);
  assert.match(sql, /p_action in \('archive_attempt', 'restore_attempt', 'remove_attempt_permanently'\)[\s\S]*insert into public\.organization_attempt_tombstones/);
});

test("commands and sync are atomic, bounded and idempotent", () => {
  assert.match(sql, /organization_command_receipts/);
  assert.match(sql, /organization_sync_receipts/);
  assert.match(sql, /pg_advisory_xact_lock/g);
  assert.match(sql, /Request identifier was already used with different data/);
  assert.match(sql, /jsonb_array_length\(p_attempts\) > 100/);
  assert.match(sql, /octet_length\(p_attempts::text\) > 8388608/);
  assert.match(sql, /octet_length\(v_item::text\) > 2097152/);
});

test("all canonical organization commands are implemented in SQL", () => {
  const actions = [
    "submit_application", "withdraw_application", "decide_application",
    "suspend_organization", "restore_organization", "invite_member",
    "accept_invitation", "request_to_join", "decide_join_request",
    "request_to_leave", "decide_leave_request", "request_access_change",
    "decide_access_request", "assign_teacher", "assign_teacher_batch", "unassign_teacher",
    "change_member_role", "suspend_member", "restore_member", "remove_member",
    "archive_attempt", "restore_attempt", "remove_attempt_permanently",
    "set_prior_history_sharing", "reserve_seat", "release_seat",
  ];
  for (const action of actions) assert.match(sql, new RegExp(`'${action}'`));
  assert.match(sql, /if not coalesce\(p_platform_admin, false\)[\s\S]*suspend_organization/);
  assert.match(sql, /if p_action in \('archive_attempt', 'restore_attempt'\)[\s\S]*v_role = 'teacher'/);
  assert.match(sql, /if not coalesce\(p_platform_admin, false\) and v_role not in \('manager', 'owner'\) then raise exception 'Not permitted\.'/);
});

test("batch teacher assignment is one bounded atomic database command", () => {
  assert.match(sql, /p_action = 'assign_teacher_batch'/);
  assert.match(sql, /jsonb_array_length\(p_payload -> 'studentUserIds'\) not between 1 and 500/);
  assert.match(sql, /select array_agg\(distinct item::uuid\) into v_student_ids/);
  assert.match(sql, /from unnest\(v_student_ids\) selected\(student_id\)/);
  assert.match(sql, /'studentUserIds', to_jsonb\(v_student_ids\)/);
});

test("existing databases receive batch assignment through a private idempotent incremental RPC", () => {
  assert.match(batchSql, /create or replace function public\.organization_assign_teacher_batch/);
  assert.match(batchSql, /jsonb_array_length\(p_students\) not between 1 and 500/);
  assert.match(batchSql, /organization_command_receipts/);
  assert.match(batchSql, /pg_advisory_xact_lock/);
  assert.match(batchSql, /Request identifier was already used with different data/);
  assert.match(batchSql, /perform public\.organization_audit/);
  assert.match(batchSql, /revoke all on function public\.organization_assign_teacher_batch[\s\S]*from public, anon, authenticated/);
  assert.match(batchSql, /grant execute on function public\.organization_assign_teacher_batch[\s\S]*to service_role/);
  assert.doesNotMatch(batchSql, /grant execute[\s\S]*to (?:anon|authenticated)/i);
});

test("platform workspace selection and join consent are database-enforced and private", () => {
  assert.match(adminConsentSql, /create or replace function public\.organization_portal_selected/);
  assert.match(adminConsentSql, /organization_actor_is_platform_admin/);
  assert.match(adminConsentSql, /create or replace function public\.organization_consent_command/);
  assert.match(adminConsentSql, /Consent to share future practice history is required/);
  assert.match(adminConsentSql, /p_action not in \('request_to_join', 'accept_invitation'\)/);
  for (const fn of ["organization_portal_selected", "organization_consent_command"]) {
    assert.match(adminConsentSql, new RegExp(`revoke all on function public\\.${fn}[\\s\\S]*from public, anon, authenticated`));
    assert.match(adminConsentSql, new RegExp(`grant execute on function public\\.${fn}[\\s\\S]*to service_role`));
  }
});

test("the immutable audit ledger records privileged commands", () => {
  assert.match(sql, /create trigger organization_audit_log_immutable/);
  assert.match(sql, /raise exception '% is immutable'/);
  assert.match(sql, /perform public\.organization_audit/g);
  assert.doesNotMatch(sql, /delete\s+from\s+public\.organization_audit_log/i);
});

test("email invitations are bound to both the recipient and a strong secret", () => {
  assert.match(sql, /organization_requests_invitation_binding_check/);
  assert.match(sql, /A strong invitation token is required/);
  assert.match(sql, /invitation_token_hash = encode\(sha256\(convert_to\(v_invitation_token, 'UTF8'\)\), 'hex'\)/);
  assert.match(sql, /lower\(invited\.email\) = v_request\.invitation_email/);
  assert.doesNotMatch(sql, /coalesce\(p_payload ->> 'token', gen_random_uuid\(\)::text\)/);
});

test("account notifications accept only exact account-bound invitations without weakening email links", () => {
  assert.match(invitationSafetySql, /r\.target_user_id = p_actor/);
  assert.match(invitationSafetySql, /r\.invitation_email is null/);
  assert.match(invitationSafetySql, /nullif\(btrim\(p_payload ->> 'token'\), ''\) is not null[\s\S]*organization_command/);
  assert.match(invitationSafetySql, /organization_requests_one_pending_target_invitation/);
  assert.match(invitationSafetySql, /organization_requests_one_pending_email_invitation/);
  assert.match(invitationSafetySql, /Your join request is already awaiting review\./);
  assert.match(invitationSafetySql, /organization_command_receipts/);
  assert.match(invitationSafetySql, /revoke all on function public\.organization_consent_command[\s\S]*to service_role/);
  assert.doesNotMatch(invitationSafetySql, /grant execute[\s\S]*to (?:anon|authenticated)/i);
});

test("an invitation cannot rewrite an existing membership before acceptance", () => {
  const invitationStart = sql.indexOf("elsif p_action = 'invite_member'");
  const acceptanceStart = sql.indexOf("elsif p_action = 'accept_invitation'");
  assert.ok(invitationStart >= 0 && acceptanceStart > invitationStart);
  const invitation = sql.slice(invitationStart, acceptanceStart);
  assert.match(invitation, /existing\.status <> 'removed'/);
  assert.match(invitation, /already has a membership/);
  assert.doesNotMatch(invitation, /insert into public\.organization_memberships/);
  assert.doesNotMatch(invitation, /update public\.organization_memberships/);
});

test("accepting an invitation preserves an existing active role and cancels stale tokens", () => {
  const acceptanceStart = sql.indexOf("elsif p_action = 'accept_invitation'");
  const assignmentStart = sql.indexOf("elsif p_action in ('assign_teacher'", acceptanceStart);
  const acceptance = sql.slice(acceptanceStart, assignmentStart);
  assert.match(acceptance, /v_membership\.status <> 'removed'/);
  assert.match(acceptance, /already have an active membership/);
  assert.match(acceptance, /set status = 'cancelled'/);
  assert.match(acceptance, /id <> v_request\.id/);
});

test("member management cannot bypass learner consent or retain stale assignments", () => {
  assert.match(sql, /Invite this person as a student so they can accept history sharing first/);
  assert.match(sql, /v_membership\.status <> 'suspended'/);
  assert.match(sql, /former member must accept a new invitation/i);
  assert.match(sql, /v_requested_role <> v_membership\.role/);
});

test("future-history consent changes require an assigned teacher or manager decision", () => {
  assert.match(sql, /v_request\.note = 'scope:future'/);
  assert.match(sql, /share_future_history = coalesce\(v_request\.requested_value, false\)/);
  assert.match(sql, /p_payload ->> 'scope' = 'future'/);
  assert.match(sql, /v_role = 'teacher'/);
  assert.match(sql, /organization_is_assigned\(p_actor, r\.organization_id, r\.requester_user_id\)/);
  const cloudflareConsent = readFileSync(
    join(process.cwd(), "cloudflare", "migrations", "0007_organization_future_history_consent.sql"),
    "utf8",
  );
  assert.doesNotMatch(cloudflareConsent, /share_future_history = 1\)/);
});

test("irreversible organization deletion requires an explicit reason", () => {
  assert.match(sql, /A reason is required for permanent removal/);
  assert.match(sql, /char_length\(btrim\(p_payload ->> 'reason'\)\) < 3/);
  assert.match(sql, /organization_attempt_tombstones_reason_check/);
});

test("immutable organization evidence survives account deletion without blocking it", () => {
  const audit = sql.slice(
    sql.indexOf("create table if not exists public.organization_audit_log"),
    sql.indexOf("create index if not exists organization_audit_log_org_time_idx"),
  );
  const tombstone = sql.slice(
    sql.indexOf("create table if not exists public.organization_attempt_tombstones"),
    sql.indexOf("create table if not exists public.organization_audit_log"),
  );
  assert.doesNotMatch(audit, /actor_user_id\s+uuid references auth\.users/);
  assert.doesNotMatch(audit, /target_user_id\s+uuid references auth\.users/);
  assert.doesNotMatch(tombstone, /attempt_id\s+uuid[^\n]*references/);
  assert.match(sql, /organization_audit_log_insert_guard/);
});

test("suspended organizations are visible only to platform administration", () => {
  assert.match(sql, /coalesce\(p_platform_admin, false\)[\s\S]*or \(o\.status = 'active' and exists/);
  assert.match(sql, /or \(o\.status = 'active' and public\.organization_is_assigned/);
  assert.match(sql, /and o\.status = 'active'[\s\S]*order by m\.joined_at desc/);
  assert.match(sql, /Organization is not active\./);
});

test("student history loads its composite membership row with valid PL/pgSQL", () => {
  assert.match(sql, /select m\.\*[\s\S]*into v_membership[\s\S]*v_org := v_membership\.organization_id/);
  assert.doesNotMatch(sql, /select m\.organization_id, m\s+into v_org, v_membership/);
});

test("the platform-admin hint is verified against the database", () => {
  assert.match(sql, /create or replace function public\.organization_actor_is_platform_admin/);
  assert.ok((sql.match(/Invalid platform authority\./g) ?? []).length >= 3);
  assert.match(sql, /revoke all on function public\.organization_actor_is_platform_admin\(uuid\)/);
});

test("decision actions cannot approve a different request kind", () => {
  assert.match(sql, /p_action = 'decide_leave_request' and v_request\.kind <> 'leave'/);
  assert.match(sql, /p_action = 'decide_access_request' and v_request\.kind <> 'history_access_change'/);
  assert.match(sql, /Request type does not match the decision/);
});

test("already-migrated databases receive former-member consent through private additive RPCs", () => {
  assert.match(formerConsentSql, /organization_portal_with_former_memberships/);
  assert.match(formerConsentSql, /m\.status = 'removed'/);
  assert.match(formerConsentSql, /v_membership\.status in \('active', 'leave_requested'\)/);
  assert.match(formerConsentSql, /v_membership\.status <> 'removed'/);
  assert.match(formerConsentSql, /directAfterLeaving/);
  assert.match(formerConsentSql, /revoke all on function public\.organization_history_sharing_command\(uuid, boolean, jsonb, text\)[\s\S]*from public, anon, authenticated/);
  assert.match(formerConsentSql, /grant execute on function public\.organization_history_sharing_command\(uuid, boolean, jsonb, text\)[\s\S]*to service_role/);
});
