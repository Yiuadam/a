import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const tracking = await import(
  pathToFileURL(join(process.cwd(), "lib", "ai", "cost-tracking.ts")).href
);

test("Haiku usage is priced exactly, including both cache TTLs and cache reads", () => {
  const cost = tracking.calculateAnthropicTokenCost(
    "claude-haiku-4-5-20251001",
    {
      input_tokens: 1_000,
      output_tokens: 1_000,
      cache_creation_input_tokens: 1_000,
      cache_read_input_tokens: 1_000,
      cache_creation: {
        ephemeral_5m_input_tokens: 600,
        ephemeral_1h_input_tokens: 400,
      },
    },
    new Date("2026-08-12T00:00:00.000Z"),
  );

  assert.equal(cost.pricingTier, "haiku_4_5");
  assert.equal(cost.cacheCreation5mInputTokens, 600);
  assert.equal(cost.cacheCreation1hInputTokens, 400);
  assert.equal(cost.costUsdNanodollars, BigInt(7_650_000));
  assert.equal(cost.costUsd, "0.00765");
});

test("an undifferentiated cache creation total uses Anthropic's default 5-minute TTL", () => {
  const cost = tracking.calculateAnthropicTokenCost(
    "claude-haiku-4-5",
    {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 0,
    },
    new Date("2026-08-12T00:00:00.000Z"),
  );

  assert.equal(cost.cacheCreation5mInputTokens, 1);
  assert.equal(cost.cacheCreation1hInputTokens, 0);
  assert.equal(cost.costUsd, "0.00000125");
});

test("Sonnet 5 switches from its introductory rate only after August 31 UTC", () => {
  const usage = {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  const august = tracking.calculateAnthropicTokenCost(
    "claude-sonnet-5",
    usage,
    new Date("2026-08-31T23:59:59.999Z"),
  );
  const september = tracking.calculateAnthropicTokenCost(
    "claude-sonnet-5",
    usage,
    new Date("2026-09-01T00:00:00.000Z"),
  );

  assert.equal(august.pricingTier, "sonnet_5_intro");
  assert.equal(august.costUsd, "12");
  assert.equal(september.pricingTier, "sonnet_5_standard");
  assert.equal(september.costUsd, "18");
});

test("invalid or unknown provider usage is refused instead of silently mispriced", () => {
  assert.throws(
    () =>
      tracking.calculateAnthropicTokenCost(
        "claude-haiku-4-5",
        {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 4,
          cache_creation: {
            ephemeral_5m_input_tokens: 3,
            ephemeral_1h_input_tokens: 2,
          },
        },
        new Date("2026-08-12T00:00:00.000Z"),
      ),
    /breakdown exceeds its total/,
  );
  assert.throws(
    () =>
      tracking.calculateAnthropicTokenCost(
        "claude-unknown-1",
        { input_tokens: 1, output_tokens: 1 },
        new Date("2026-08-12T00:00:00.000Z"),
      ),
    /No local Anthropic price/,
  );
});

test("successful responses are recorded before refusal and JSON handling", () => {
  const source = readFileSync(join(process.cwd(), "lib", "anthropic.ts"), "utf8");
  assert.match(
    source,
    /after\(\(\) => recordAnthropicMessageCost\(event\)\)/,
    "cost persistence blocks the learner response instead of using Next's lifecycle",
  );
  assert.doesNotMatch(source, /await recordCost\(/);
  const betaRecord = source.indexOf("recordCost(opts.route, message)");
  const betaRead = source.indexOf("text = readResult(message)", betaRecord);
  const standardRecord = source.indexOf("recordCost(opts.route, message)", betaRecord + 1);
  const standardRead = source.indexOf("text = readResult(message)", standardRecord);

  assert.ok(betaRecord >= 0 && betaRecord < betaRead, "beta usage is not recorded before parsing");
  assert.ok(
    standardRecord >= 0 && standardRecord < standardRead,
    "standard usage is not recorded before parsing",
  );
});

test("the ledger is private, idempotent, distinguishes backfill, and stores no learner data", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase", "migrations", "0015_ai_cost_tracking.sql"),
    "utf8",
  );

  assert.match(sql, /source in \('calculated_tokens', 'provider_backfill'\)/);
  assert.match(sql, /on conflict \(provider_request_id\) do nothing/);
  assert.match(sql, /on conflict \(external_reference\) do nothing/);
  assert.match(sql, /create or replace function public\.set_ai_cost_coverage/);
  assert.match(sql, /'historicalComplete',[\s\S]*historical_complete/);
  assert.match(sql, /revoke all on table public\.ai_cost_events[\s\S]*service_role/);
  assert.match(sql, /grant execute on function public\.admin_ai_cost_snapshot\(integer\)[\s\S]*service_role/);
  assert.doesNotMatch(sql, /\b(?:user_id|email|prompt|response_content)\s+(?:text|uuid|jsonb)\b/i);
  assert.doesNotMatch(sql, /\b0\.4[12]\b/);
  assert.doesNotMatch(sql, /\b2026-\d{2}-\d{2}\b/);
});
