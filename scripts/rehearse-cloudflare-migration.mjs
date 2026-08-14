#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const epoch = "2026-08-12T00:00:00.000Z";
const ids = {
  admin: "10000000-0000-4000-8000-000000000001",
  student: "10000000-0000-4000-8000-000000000002",
  teacher: "10000000-0000-4000-8000-000000000003",
  application: "20000000-0000-4000-8000-000000000001",
  organization: "30000000-0000-4000-8000-000000000001",
  pool: "40000000-0000-4000-8000-000000000001",
  allocation: "40000000-0000-4000-8000-000000000002",
  studentMembership: "50000000-0000-4000-8000-000000000001",
  teacherMembership: "50000000-0000-4000-8000-000000000002",
  assignment: "60000000-0000-4000-8000-000000000001",
  request: "70000000-0000-4000-8000-000000000001",
  attempt: "80000000-0000-4000-8000-000000000001",
};
const avatarPath = `${ids.student}/fixture.webp`;
const avatarBytes = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50,
]);

const result = {
  module: "writing",
  testId: "writing-rehearsal",
  testTitle: "Migration rehearsal",
  band: 7,
  date: epoch,
  review: { kind: "writing", attempts: [{ response: "A".repeat(110_000) }] },
};

const profiles = [
  { id: ids.admin, email: "admin@rehearsal.invalid", role: "admin", display_name: "Admin", avatar_path: null, birth_date: null, created_at: epoch, updated_at: epoch },
  { id: ids.student, email: "student@rehearsal.invalid", role: "user", display_name: "Student", avatar_path: avatarPath, birth_date: "2000-01-01", created_at: epoch, updated_at: epoch },
  { id: ids.teacher, email: "teacher@rehearsal.invalid", role: "user", display_name: "Teacher", avatar_path: null, birth_date: null, created_at: epoch, updated_at: epoch },
];

const rows = {
  profiles,
  app_settings: [{ key: "maintenance", value: { closed: false, at: epoch }, updated_at: epoch, updated_by: ids.admin }],
  progress_snapshots: [{ user_id: ids.student, store_key: "ielts-prep-v1", payload: { results: [result] }, client_updated_at: epoch, created_at: epoch, updated_at: epoch }],
  subscriptions: [{ id: "90000000-0000-4000-8000-000000000001", user_id: ids.student, provider: "stripe", status: "active", tier: "plus", external_customer_id: "cus_rehearsal", external_subscription_id: "sub_rehearsal", original_transaction_id: null, external_price_id: "price_rehearsal", current_period_end: "2027-08-12T00:00:00.000Z", cancel_at_period_end: false, provider_event_at: epoch, verified_at: epoch, raw: { rehearsal: true }, created_at: epoch, updated_at: epoch }],
  usernames: [{ username: "rehearsal", user_id: ids.student, created_at: epoch }],
  provider_events: [{ provider: "stripe", event_id: "evt_rehearsal", received_at: epoch, processed_at: epoch, payload: { rehearsal: true } }],
  usage_events: [{ id: 1, user_id: ids.student, route: "grade/writing", ip_hash: "fixture", outcome: "admitted", created_at: epoch }],
  ai_cost_events: [{ id: 1, source: "provider_backfill", provider_request_id: null, external_reference: "rehearsal", route: null, model: null, input_tokens: null, output_tokens: null, cache_creation_input_tokens: null, cache_creation_5m_input_tokens: null, cache_creation_1h_input_tokens: null, cache_read_input_tokens: null, cost_usd: "0.123456789", occurred_at: epoch, recorded_at: epoch }],
  ai_cost_coverage: [{ singleton: true, source: "provider_console", starts_at: epoch, historical_complete: true, recorded_at: epoch }],
  organization_applications: [{ id: ids.application, applicant_user_id: ids.admin, organization_name: "Rehearsal Academy", purpose: "Validate organization migration", country: "HK", contact_email: "admin@rehearsal.invalid", estimated_students: 1, applicant_role: "Owner", status: "approved", submitted_at: epoch, reviewed_at: epoch, reviewed_by: ids.admin, review_note: "fixture", created_at: epoch, updated_at: epoch }],
  organizations: [{ id: ids.organization, application_id: ids.application, name: "Rehearsal Academy", slug: "rehearsal-academy", join_code: "abcdef123456", status: "active", created_by: ids.admin, created_at: epoch, updated_at: epoch }],
  organization_seat_pools: [{ id: ids.pool, organization_id: ids.organization, provider: "wechat_pay", external_subscription_id: "wechat_rehearsal", purchased_seats: 2, status: "paused", starts_at: epoch, ends_at: null, created_at: epoch, updated_at: epoch }],
  organization_memberships: [
    { id: ids.studentMembership, organization_id: ids.organization, user_id: ids.student, role: "student", status: "active", share_future_history: true, share_pre_join_history: false, joined_at: epoch, status_changed_at: epoch, created_at: epoch, updated_at: epoch },
    { id: ids.teacherMembership, organization_id: ids.organization, user_id: ids.teacher, role: "teacher", status: "active", share_future_history: true, share_pre_join_history: false, joined_at: epoch, status_changed_at: epoch, created_at: epoch, updated_at: epoch },
  ],
  teacher_student_assignments: [{ id: ids.assignment, organization_id: ids.organization, teacher_user_id: ids.teacher, student_user_id: ids.student, assigned_by: ids.admin, created_at: epoch, revoked_at: null, revoked_by: null }],
  organization_seat_allocations: [{ id: ids.allocation, organization_id: ids.organization, seat_pool_id: ids.pool, user_id: ids.student, status: "active", starts_at: epoch, ends_at: null, allocated_by: ids.admin, created_at: epoch, updated_at: epoch }],
  organization_requests: [{ id: ids.request, organization_id: ids.organization, kind: "history_access_change", status: "approved", requester_user_id: ids.student, target_user_id: ids.student, requested_role: null, requested_value: true, invitation_email: null, invitation_token_hash: null, note: "fixture", decided_by: ids.admin, decided_at: epoch, created_at: epoch, updated_at: epoch }],
  practice_attempts: [{ id: ids.attempt, user_id: ids.student, source_key: "writing:fixture", module: "writing", test_id: result.testId, test_title: result.testTitle, band: 7, raw_score: null, score_out_of: null, submitted_at: epoch, payload: result, created_at: epoch, updated_at: epoch }],
  organization_attempt_archives: [{ organization_id: ids.organization, attempt_id: ids.attempt, archived_by: ids.teacher, archived_at: epoch, reason: "fixture", restored_by: ids.admin, restored_at: "2026-08-12T00:01:00.000Z" }],
  organization_attempt_tombstones: [],
  organization_audit_log: [{ id: 1, organization_id: ids.organization, actor_user_id: ids.admin, action: "fixture", target_user_id: ids.student, entity_type: "student", entity_id: ids.student, details: { rehearsal: true }, created_at: epoch }],
  organization_command_receipts: [{ actor_user_id: ids.admin, idempotency_key: "rehearsal-command-0001", action: "restore_member", request_hash: "a".repeat(64), response: { ok: true }, created_at: epoch }],
  organization_sync_receipts: [{ actor_user_id: ids.student, idempotency_key: "rehearsal-sync-000001", request_hash: "b".repeat(64), response: { ok: true, synced: 1 }, created_at: epoch }],
};

function run(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: process.cwd(), env: { ...process.env, ...options.env, WRANGLER_LOG_PATH: "/tmp/bandup-rehearsal-wrangler.log" }, stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => code === 0
      ? resolve(stdout)
      : reject(new Error(`${program} exited ${code ?? `by signal ${signal ?? "unknown"}`}: ${stderr.slice(-1200)}`)));
  });
}

async function main() {
  const persist = await mkdtemp(join(tmpdir(), "bandup-migration-rehearsal-"));
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url, "http://localhost");
    if (requestUrl.pathname === `/storage/v1/object/avatars/${avatarPath}`) {
      response.writeHead(200, { "Content-Type": "image/webp" });
      response.end(avatarBytes);
      return;
    }
    const table = requestUrl.pathname.split("/").at(-1);
    if (!(table in rows)) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ code: "PGRST205" }));
      return;
    }
    const offset = Number(requestUrl.searchParams.get("offset") ?? 0);
    const limit = Number(requestUrl.searchParams.get("limit") ?? 40);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(rows[table].slice(offset, offset + limit)));
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server did not start");
    await run("npx", ["wrangler", "d1", "migrations", "apply", "BANDUP_DB", "--config", "wrangler.migration-preview.jsonc", "--local", "--persist-to", persist]);
    const migrationOutput = await run("node", ["scripts/migrate-supabase-to-cloudflare.mjs", "--preview", "--local", `--persist-to=${persist}`], {
      env: { SUPABASE_URL: `http://127.0.0.1:${address.port}`, SUPABASE_SERVICE_ROLE_KEY: "rehearsal-only" },
      capture: true,
    });
    if (!/Copy complete\. Run id: [0-9a-f-]+/i.test(migrationOutput)) {
      throw new Error("migration rehearsal did not reach a verified complete run");
    }
    const output = await run("npx", ["wrangler", "d1", "execute", "BANDUP_DB", "--config", "wrangler.migration-preview.jsonc", "--local", "--persist-to", persist, "--command", "SELECT (SELECT count(*) FROM app_users WHERE email LIKE '%@rehearsal.invalid') AS users, (SELECT count(*) FROM learner_profiles WHERE user_id='10000000-0000-4000-8000-000000000002' AND avatar_object_key LIKE 'private/avatars/%') AS avatars, (SELECT count(*) FROM organizations WHERE id='30000000-0000-4000-8000-000000000001') AS organizations, (SELECT count(*) FROM practice_attempts WHERE id='80000000-0000-4000-8000-000000000001') AS attempts, (SELECT count(*) FROM provider_events WHERE event_id='evt_rehearsal' AND payload_object_key IS NOT NULL AND length(payload_sha256)=64) AS provider_events, (SELECT count(*) FROM data_migration_runs WHERE status='complete') AS completed_runs, (SELECT count(*) FROM data_migration_checkpoints) AS checkpoints;", "--json"], { capture: true });
    const parsed = JSON.parse(output)[0]?.results?.[0];
    if (!parsed || parsed.users !== 3 || parsed.avatars !== 1 || parsed.organizations !== 1 || parsed.attempts !== 1 || parsed.provider_events !== 1 || parsed.completed_runs !== 1 || parsed.checkpoints < 18) {
      throw new Error(`migration rehearsal counts failed: ${JSON.stringify(parsed)}`);
    }
    process.stdout.write(`Migration rehearsal passed: ${JSON.stringify(parsed)}\n`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(persist, { recursive: true, force: true });
  }
}

await main().catch((error) => {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = 1;
});
