import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const replica = await import(pathToFileURL(
  join(process.cwd(), "lib", "cloudflare", "usage-cost-replica.ts"),
).href);
const costTracking = await import(pathToFileURL(
  join(process.cwd(), "lib", "ai", "cost-tracking.ts"),
).href);

function runtimeD1(database) {
  const execute = (sql, values) => {
    const result = database.prepare(sql).run(...values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes ?? 0) },
    };
  };
  const bound = (sql, values) => ({
    sql,
    values,
    async run() { return execute(sql, values); },
    async first(column) {
      const row = database.prepare(sql).get(...values) ?? null;
      return column && row ? row[column] ?? null : row;
    },
  });
  return {
    prepare(sql) {
      return {
        bind: (...values) => bound(sql, values),
        ...bound(sql, []),
      };
    },
  };
}

function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(process.cwd(), "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "cloudflare", "migrations", file), "utf8"));
  }
  return {
    database,
    bindings: { db: runtimeD1(database), files: {} },
  };
}

const USER = {
  id: "50000000-0000-4000-8000-000000000071",
  email: "dual-usage@example.test",
};

test("usage decisions mirror with the Supabase id, include refusals, and retry once", async () => {
  const context = fixture();
  const base = {
    userId: USER.id,
    route: "chat",
    ipHash: "one-way-hash",
    createdAt: "2026-08-14T08:00:00.000Z",
  };

  assert.equal(await replica.mirrorCloudflareUsageEvent({
    ...base,
    id: "701",
    outcome: "admitted",
  }, USER, context.bindings), true);
  assert.equal(await replica.mirrorCloudflareUsageEvent({
    ...base,
    id: "702",
    outcome: "denied_quota",
  }, USER, context.bindings), true);
  assert.equal(await replica.mirrorCloudflareUsageEvent({
    ...base,
    id: "702",
    outcome: "denied_quota",
  }, USER, context.bindings), true);

  assert.equal(
    context.database.prepare("SELECT count(*) AS count FROM app_users").get().count,
    1,
  );
  assert.equal(
    context.database.prepare("SELECT count(*) AS count FROM usage_events").get().count,
    2,
  );
  assert.deepEqual(
    context.database.prepare(
      "SELECT id, outcome FROM usage_events ORDER BY CAST(id AS INTEGER)",
    ).all().map((row) => ({ ...row })),
    [
      { id: "701", outcome: "admitted" },
      { id: "702", outcome: "denied_quota" },
    ],
  );
});

test("anonymous refusal mirrors without manufacturing an account", async () => {
  const context = fixture();
  assert.equal(await replica.mirrorCloudflareUsageEvent({
    id: "703",
    userId: null,
    route: "define",
    ipHash: "anonymous-hash",
    outcome: "denied_rate",
    createdAt: "2026-08-14T08:01:00.000Z",
  }, null, context.bindings), true);
  assert.equal(
    context.database.prepare("SELECT count(*) AS count FROM app_users").get().count,
    0,
  );
  assert.equal(
    context.database.prepare("SELECT outcome FROM usage_events WHERE id = '703'").get().outcome,
    "denied_rate",
  );
});

test("a usage replica cannot attach an event to a different verified account", async () => {
  const context = fixture();
  await assert.rejects(() => replica.mirrorCloudflareUsageEvent({
    id: "704",
    userId: USER.id,
    route: "generate",
    ipHash: null,
    outcome: "admitted",
    createdAt: "2026-08-14T08:02:00.000Z",
  }, { id: "50000000-0000-4000-8000-000000000072", email: null }, context.bindings),
  /does not match/);
  assert.equal(
    context.database.prepare("SELECT count(*) AS count FROM usage_events").get().count,
    0,
  );
});

test("AI cost and coverage mirrors are idempotent and coverage is monotonic", async () => {
  const context = fixture();
  const event = {
    id: "801",
    source: "calculated_tokens",
    providerRequestId: "msg_provider_801",
    route: "grade/writing",
    model: "claude-haiku-4-5",
    inputTokens: 123,
    outputTokens: 45,
    cacheCreationInputTokens: 10,
    cacheCreation5mInputTokens: 7,
    cacheCreation1hInputTokens: 3,
    cacheReadInputTokens: 9,
    costUsd: "0.000456789",
    occurredAt: "2026-08-14T08:03:00.000Z",
    recordedAt: "2026-08-14T08:03:01.000Z",
  };
  assert.equal(await replica.mirrorCloudflareAiCostEvent(event, context.bindings), true);
  assert.equal(await replica.mirrorCloudflareAiCostEvent(event, context.bindings), true);
  assert.equal(
    context.database.prepare("SELECT count(*) AS count FROM ai_cost_events").get().count,
    1,
  );
  assert.equal(
    context.database.prepare(
      "SELECT provider_request_id FROM ai_cost_events WHERE id = '801'",
    ).get().provider_request_id,
    "msg_provider_801",
  );

  assert.equal(await replica.mirrorCloudflareAiCostCoverage({
    source: "provider_console",
    startsAt: "2026-01-01T00:00:00.000Z",
    historicalComplete: true,
    recordedAt: "2026-08-14T08:05:00.000Z",
  }, context.bindings), true);
  assert.equal(await replica.mirrorCloudflareAiCostCoverage({
    source: "local_tracking",
    startsAt: "2026-08-01T00:00:00.000Z",
    historicalComplete: false,
    recordedAt: "2026-08-14T08:04:00.000Z",
  }, context.bindings), true);
  assert.deepEqual(
    { ...context.database.prepare(
      "SELECT source, starts_at, historical_complete FROM ai_cost_coverage WHERE singleton = 1",
    ).get() },
    {
      source: "provider_console",
      starts_at: "2026-01-01T00:00:00.000000000Z",
      historical_complete: 1,
    },
  );
});

test("a missing D1 binding never changes an authoritative Supabase cost outcome", async () => {
  const names = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_ANON_KEY",
    "CLOUDFLARE_DATA_MODE",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const savedFetch = globalThis.fetch;
  const savedError = console.error;
  const errors = [];
  const calls = [];
  Object.assign(process.env, {
    SUPABASE_URL: "https://supabase-dual.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
    SUPABASE_ANON_KEY: "anon-test-value",
    CLOUDFLARE_DATA_MODE: "dual",
  });
  console.error = (...parts) => errors.push(parts.join(" "));
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith("/rpc/record_ai_cost_event_with_identity")) {
      return Response.json({
        inserted: true,
        event: {
          id: "902",
          source: "calculated_tokens",
          providerRequestId: "msg_dual_902",
          route: "define",
          model: "claude-haiku-4-5",
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationInputTokens: 0,
          cacheCreation5mInputTokens: 0,
          cacheCreation1hInputTokens: 0,
          cacheReadInputTokens: 0,
          costUsd: "0.000035",
          occurredAt: "2026-08-14T09:01:00.000Z",
          recordedAt: "2026-08-14T09:01:01.000Z",
        },
        coverage: null,
      });
    }
    throw new Error(`unexpected request ${url}`);
  };

  try {
    assert.equal(await costTracking.recordAnthropicMessageCost({
      providerRequestId: "msg_dual_902",
      route: "define",
      model: "claude-haiku-4-5",
      usage: { input_tokens: 10, output_tokens: 5 },
      occurredAt: new Date("2026-08-14T09:01:00.000Z"),
    }), true, "a D1 outage changed a successful Supabase cost write into failure");
  } finally {
    globalThis.fetch = savedFetch;
    console.error = savedError;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }

  assert.equal(calls.length, 1);
  assert.ok(errors.some((line) => line.includes("Cloudflare event replica")));
});

test("dual paths keep Supabase first and isolate Cloudflare replica failures", () => {
  const guard = readFileSync(join(process.cwd(), "lib", "usage", "guard.ts"), "utf8");
  const cost = readFileSync(join(process.cwd(), "lib", "ai", "cost-tracking.ts"), "utf8");
  const migration = readFileSync(
    join(process.cwd(), "supabase", "migrations", "0028_dual_usage_cost_identity.sql"),
    "utf8",
  );

  const usageRpc = guard.indexOf("check_and_record_usage_with_event");
  const usageMirror = guard.indexOf("await mirrorUsageDecision");
  const usageReturn = guard.indexOf("if (decision.allowed) return null");
  assert.ok(usageRpc >= 0 && usageRpc < usageMirror && usageMirror < usageReturn);
  assert.match(guard, /checkAiUsage\/cloudflare-replica/);

  const costRpc = cost.indexOf("record_ai_cost_event_with_identity");
  const costMirror = cost.indexOf("await mirrorStoredCostResponse");
  assert.ok(costRpc >= 0 && costRpc < costMirror);
  assert.match(cost, /Cloudflare event replica/);
  assert.match(cost, /set_ai_cost_coverage_with_identity/);

  assert.match(migration, /v_decision := public\.check_and_record_usage/);
  assert.match(migration, /currval\(pg_get_serial_sequence\('public\.usage_events', 'id'\)\)/);
  assert.match(migration, /'eventId', v_event\.id::text/);
  assert.match(migration, /where provider_request_id = p_provider_request_id/);
  assert.match(migration, /revoke all on function public\.check_and_record_usage_with_event/);
  assert.match(migration, /grant execute on function public\.record_ai_cost_event_with_identity/);
});
