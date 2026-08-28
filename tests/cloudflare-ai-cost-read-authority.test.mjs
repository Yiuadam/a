import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);
const localCost = await load("lib", "admin", "finance-local-cost.ts");
const periodModule = await load("lib", "admin", "finance-period.ts");
const reader = await load("lib", "cloudflare", "ai-cost-read-authority.ts");

const asOf = new Date("2026-08-12T12:34:56.000Z");

test("D1 owner AI-cost reader preserves decimal money and provenance exactly", () => {
  const snapshot = reader.summarizeCloudflareAiCostLedger(
    [
      {
        id: "1",
        source: "calculated_tokens",
        cost_usd: "0.0025",
        input_tokens: 1200,
        output_tokens: 300,
        cache_creation_input_tokens: 25,
        cache_read_input_tokens: 50,
        occurred_at: "2026-08-12T09:00:00.000Z",
      },
      {
        id: "2",
        source: "provider_backfill",
        cost_usd: "10.01",
        input_tokens: null,
        output_tokens: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        occurred_at: "2026-07-01T00:00:00.000Z",
      },
      {
        id: "3",
        source: "calculated_tokens",
        cost_usd: "0.1",
        input_tokens: 2,
        output_tokens: 3,
        cache_creation_input_tokens: 4,
        cache_read_input_tokens: 5,
        occurred_at: "2026-07-13T23:59:59.000Z",
      },
    ],
    {
      source: "provider_console",
      starts_at: "2026-01-01T00:00:00.000Z",
      historical_complete: 1,
    },
    30,
    asOf,
  );

  assert.equal(snapshot.source, "local_cost_ledger");
  assert.equal(snapshot.lifetime.costMinorUnits, "10.1125");
  assert.equal(snapshot.lifetime.calculatedCostMinorUnits, "0.1025");
  assert.equal(snapshot.lifetime.providerBackfillCostMinorUnits, "10.01");
  assert.equal(snapshot.lifetime.inputTokens, "1202");
  assert.equal(snapshot.period.costMinorUnits, "0.0025");
  assert.equal(snapshot.period.requestCount, "1");
  assert.equal(snapshot.period.backfillRowCount, "0");
  assert.equal(snapshot.coverage.includesProviderBackfill, true);
  assert.equal(snapshot.daily.length, 30);
  assert.equal(snapshot.daily.at(-1).costMinorUnits, "0.0025");

  const parsed = localCost.parseLocalAiCost(snapshot, periodModule.financePeriod(asOf));
  assert.equal(parsed.lifetime.cost.minorUnits, "10.1125");
  assert.equal(parsed.period.tokenCost.minorUnits, "0.0025");
});

test("D1 owner AI-cost reader rejects invalid values rather than rounding or trusting them", () => {
  assert.throws(
    () => reader.summarizeCloudflareAiCostLedger(
      [{
        id: "1",
        source: "calculated_tokens",
        cost_usd: "not-a-decimal",
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        occurred_at: "2026-08-12T00:00:00.000Z",
      }],
      null,
      30,
      asOf,
    ),
    /invalid cost/,
  );
  assert.throws(
    () => reader.summarizeCloudflareAiCostLedger(
      [{
        id: "1",
        source: "unknown",
        cost_usd: "1",
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        occurred_at: "2026-08-12T00:00:00.000Z",
      }],
      null,
      30,
      asOf,
    ),
    /invalid source/,
  );
});

test("owner finance route remains available to a native Cloudflare session", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(
    join(process.cwd(), "app", "api", "admin", "finance", "route.ts"),
    "utf8",
  ));
  assert.match(source, /accountRuntimeEnabled\(\)/);
  assert.doesNotMatch(source, /supabaseConfigured\(\)/);
});
