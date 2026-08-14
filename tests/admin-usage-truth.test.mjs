import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(path, "utf8");

test("owner diagnostics are read-only and cannot inflate AI usage", () => {
  const diagnostics = read("app/api/account/diagnostics/route.ts");
  const checksPage = read("app/billing/checks/page.tsx");
  assert.doesNotMatch(diagnostics, /check_and_record_usage/);
  assert.doesNotMatch(diagnostics, /limitsForDatabase/);
  assert.match(diagnostics, /usage_limits_schema/);
  assert.match(checksPage, /without adding artificial AI usage/);
});

test("admin usage copy describes BandUp gate decisions, not provider refusals", () => {
  const chart = read("components/admin/AdminTrendChart.tsx");
  const overview = read("app/admin/page.tsx");
  const traffic = read("app/admin/traffic/page.tsx");
  assert.match(chart, /blocked before AI/);
  assert.match(chart, /before an AI provider was called/);
  assert.doesNotMatch(chart, />\s*Served\s*</);
  assert.doesNotMatch(chart, />\s*Refused\s*</);
  assert.match(overview, /AI request attempts/);
  assert.match(traffic, /BandUp stopped the request before calling an AI provider/);
});

test("stats expose an identity-free route, reason and caller breakdown", () => {
  const migration = read("supabase/migrations/0027_admin_usage_truth.sql");
  const route = read("app/api/admin/stats/route.ts");
  const consoleParts = read("components/admin/ConsoleParts.tsx");
  assert.match(migration, /admin_usage_breakdown/);
  assert.match(migration, /blocked_quota/);
  assert.match(migration, /blocked_rate/);
  assert.match(migration, /signed_in/);
  assert.match(migration, /anonymous/);
  assert.doesNotMatch(migration, /select[^;]*(?:email|ip_hash)/i);
  assert.match(route, /usageBreakdown/);
  assert.match(route, /admin_usage_daily[\s\S]*p_admin_user_id: user\.id/);
  assert.match(route, /admin_usage_breakdown[\s\S]*p_admin_user_id: user\.id/);
  assert.match(consoleParts, /AI request gate breakdown/);
  assert.match(consoleParts, /Blocked · quota/);
  assert.match(consoleParts, /Blocked · rate/);
});

test("learner-demand charts exclude the owner and use UTC calendar days", () => {
  const migration = read("supabase/migrations/0027_admin_usage_truth.sql");
  const chart = read("components/admin/AdminTrendChart.tsx");
  const traffic = read("app/admin/traffic/page.tsx");
  assert.match(migration, /admin_usage_daily\(\s*p_days integer,\s*p_admin_user_id uuid/);
  assert.match(migration, /admin_usage_breakdown\(\s*p_days integer,\s*p_admin_user_id uuid/);
  assert.match(migration, /e\.user_id is distinct from p_admin_user_id/g);
  assert.match(migration, /now\(\) at time zone 'UTC'/);
  assert.match(chart, /Learner AI request attempts/);
  assert.match(chart, /Owner activity is excluded/);
  assert.match(traffic, /Owner activity is excluded/);
});

test("tier totals count effective accounts and the environment owner once", () => {
  const migration = read("supabase/migrations/0027_admin_usage_truth.sql");
  const route = read("app/api/admin/stats/route.ts");
  const overview = read("app/admin/page.tsx");
  assert.match(migration, /resolve_entitlement\(u\.id\)/);
  assert.match(migration, /when u\.id = p_admin_user_id then 'admin'/);
  assert.doesNotMatch(migration, /from public\.subscriptions s\s+group by s\.tier/);
  assert.match(route, /p_admin_user_id: user\.id/);
  assert.match(overview, /Active Stripe subscriptions/);
  assert.match(overview, /Active subscription objects, from Stripe/);
});
