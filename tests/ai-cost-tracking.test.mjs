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

/* ------------------------------------------------------- token validation */

test("each token field is validated under its own name, not a shared generic one", () => {
  const base = {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_input_tokens: 2,
    cache_read_input_tokens: 1,
    cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 1 },
  };
  const cases = [
    ["input_tokens", "input"],
    ["output_tokens", "output"],
    ["cache_creation_input_tokens", "cache creation"],
    ["cache_read_input_tokens", "cache read"],
  ];
  for (const [field, label] of cases) {
    assert.throws(
      () => tracking.calculateAnthropicTokenCost(
        "claude-haiku-4-5",
        { ...base, [field]: -1 },
        new Date("2026-08-12T00:00:00.000Z"),
      ),
      new RegExp(`Anthropic returned an invalid ${label} token count`),
      `negative ${field} should name "${label}" in the error`,
    );
  }
  assert.throws(
    () => tracking.calculateAnthropicTokenCost(
      "claude-haiku-4-5",
      { ...base, cache_creation: { ephemeral_5m_input_tokens: -1, ephemeral_1h_input_tokens: 1 } },
      new Date("2026-08-12T00:00:00.000Z"),
    ),
    /Anthropic returned an invalid 5-minute cache creation token count/,
  );
  assert.throws(
    () => tracking.calculateAnthropicTokenCost(
      "claude-haiku-4-5",
      { ...base, cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: -1 } },
      new Date("2026-08-12T00:00:00.000Z"),
    ),
    /Anthropic returned an invalid 1-hour cache creation token count/,
  );
});

test("a token count of exactly zero is accepted; only a genuinely negative one is refused", () => {
  const cost = tracking.calculateAnthropicTokenCost(
    "claude-haiku-4-5",
    { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    new Date("2026-08-12T00:00:00.000Z"),
  );
  assert.equal(cost.costUsd, "0");
  assert.throws(
    () => tracking.calculateAnthropicTokenCost(
      "claude-haiku-4-5",
      { input_tokens: -1, output_tokens: 0 },
      new Date("2026-08-12T00:00:00.000Z"),
    ),
    /Anthropic returned an invalid input token count/,
  );
});

test("an unparseable occurrence timestamp is refused rather than priced", () => {
  assert.throws(
    () => tracking.calculateAnthropicTokenCost(
      "claude-haiku-4-5",
      { input_tokens: 1, output_tokens: 1 },
      new Date("not-a-real-date"),
    ),
    /Invalid Anthropic cost timestamp/,
  );
});

test("a Sonnet model id is matched by its prefix, not merely by ending with the family name", () => {
  // "claude-sonnet-5" alone starts with and ends with the same string, so it
  // cannot tell publishedRate's startsWith from an endsWith. A realistic
  // dated snapshot id can only pass the prefix check.
  const cost = tracking.calculateAnthropicTokenCost(
    "claude-sonnet-5-20250929",
    { input_tokens: 1, output_tokens: 1 },
    new Date("2026-08-12T00:00:00.000Z"),
  );
  assert.equal(cost.pricingTier, "sonnet_5_intro");
});

test("Sonnet's cache multipliers are exact at a rate other than $1/MTok", () => {
  // The existing cache-TTL test above runs on Haiku, whose $1/MTok input rate
  // makes multiplying and dividing by it agree — it cannot tell the two
  // apart. Sonnet's $2/MTok introductory rate can.
  const cost = tracking.calculateAnthropicTokenCost(
    "claude-sonnet-5",
    {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000,
      cache_read_input_tokens: 1_000,
      cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 400 },
    },
    new Date("2026-08-12T00:00:00.000Z"),
  );
  // 600 * 2 * 1250 (5m) + 400 * 2 * 2000 (1h) + 1000 * 2 * 100 (read)
  assert.equal(cost.costUsdNanodollars, BigInt(1_500_000 + 1_600_000 + 200_000));
});

/* ---------------------------------------------------------- nanodollars */

test("usdFromNanodollars: zero is not negative, and a genuinely negative value is signed", () => {
  assert.equal(tracking.usdFromNanodollars(BigInt(0)), "0");
  assert.equal(tracking.usdFromNanodollars(BigInt(1_000_000_000)), "1");
  assert.equal(tracking.usdFromNanodollars(BigInt(-1_000_000_000)), "-1");
  assert.equal(tracking.usdFromNanodollars(BigInt(-1)), "-0.000000001");
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

/*
  ---------------------------------------------------------------------------
  The network-facing half: recordAnthropicMessageCost, setAiCostCoverage and
  readAdminAiCostSnapshot.

  Same technique as tests/dual-usage-cost-write.test.mjs: CLOUDFLARE_DATA_MODE
  is set to "dual" and globalThis.fetch is replaced, so Supabase's own
  "_with_identity" reply — which this file's functions then have to validate
  themselves, being the last line of defence against a corrupted or malicious
  RPC response — is fully under this file's control. No Cloudflare/D1 binding
  is faked anywhere below: every D1 replica attempt is left to fail closed
  exactly as it does with no wrangler bindings present, which is itself the
  behaviour under test in a few of these (a barred write must not fall
  through to a Supabase RPC call at all).
*/
const SUPABASE_CONFIG = {
  SUPABASE_URL: "https://project.supabase.test",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  Object.assign(process.env, vars);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(vars)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

/** Answers one or more `/rpc/<name>` endpoints; records every call's body. */
function fakeSupabase(answers) {
  const calls = [];
  const fn = async (input, init = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    for (const [suffix, answer] of Object.entries(answers)) {
      if (url.endsWith(suffix)) {
        const value = typeof answer === "function" ? answer(body) : answer;
        return Response.json(value);
      }
    }
    throw new Error(`fakeSupabase: no answer configured for ${url}`);
  };
  return { fn, calls };
}

function captureErrors() {
  const lines = [];
  const original = console.error;
  console.error = (...parts) => lines.push(parts.join(" "));
  return { lines, restore: () => { console.error = original; } };
}

const GOOD_EVENT = {
  id: "12345",
  source: "calculated_tokens",
  providerRequestId: "msg_provider_good",
  route: "chat",
  model: "claude-haiku-4-5",
  inputTokens: 10,
  outputTokens: 5,
  cacheCreationInputTokens: 0,
  cacheCreation5mInputTokens: 0,
  cacheCreation1hInputTokens: 0,
  cacheReadInputTokens: 0,
  costUsd: "42",
  occurredAt: "2026-08-14T00:00:00.000Z",
  recordedAt: "2026-08-14T00:00:01.000Z",
};

const RECORD_COST_INPUT = {
  providerRequestId: "msg_provider_good",
  route: "chat",
  model: "claude-haiku-4-5",
  usage: { input_tokens: 10, output_tokens: 5 },
  occurredAt: new Date("2026-08-14T00:00:00.000Z"),
};

test("a malformed Supabase cost-event replica is refused with a field-specific reason", async () => {
  await withEnv({ ...SUPABASE_CONFIG, CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    const cases = [
      { name: "event missing entirely", event: null, message: "Supabase returned an invalid AI cost event" },
      { name: "event is an array", event: [], message: "Supabase returned an invalid AI cost event" },
      { name: "event is a primitive, not an object at all", event: "not-an-object", message: "Supabase returned an invalid AI cost event" },
      { name: "empty route", event: { ...GOOD_EVENT, route: "" }, message: "Supabase returned an invalid AI cost route" },
      { name: "empty cost amount", event: { ...GOOD_EVENT, costUsd: "" }, message: "Supabase returned an invalid AI cost amount" },
      { name: "missing id", event: { ...GOOD_EVENT, id: undefined }, message: "Supabase returned an invalid AI cost event id" },
      { name: "id starts with zero", event: { ...GOOD_EVENT, id: "0" }, message: "Supabase returned an invalid AI cost event id" },
      { name: "id has trailing garbage", event: { ...GOOD_EVENT, id: "123abc" }, message: "Supabase returned an invalid AI cost event id" },
      { name: "id has leading garbage", event: { ...GOOD_EVENT, id: "abc5" }, message: "Supabase returned an invalid AI cost event id" },
      { name: "wrong source", event: { ...GOOD_EVENT, source: "provider_backfill" }, message: "Supabase returned the wrong AI cost event source" },
      { name: "unknown route", event: { ...GOOD_EVENT, route: "not-a-real-route" }, message: "Supabase returned an invalid AI cost route" },
      { name: "cost is not numeric", event: { ...GOOD_EVENT, costUsd: "abc" }, message: "Supabase returned an invalid AI cost amount" },
      { name: "cost carries a sign", event: { ...GOOD_EVENT, costUsd: "-1" }, message: "Supabase returned an invalid AI cost amount" },
      { name: "cost has leading garbage", event: { ...GOOD_EVENT, costUsd: "xx0.5" }, message: "Supabase returned an invalid AI cost amount" },
      { name: "cost has trailing garbage", event: { ...GOOD_EVENT, costUsd: "0.5xx" }, message: "Supabase returned an invalid AI cost amount" },
      { name: "missing provider request id", event: { ...GOOD_EVENT, providerRequestId: "" }, message: "Supabase returned an invalid provider request id" },
      { name: "missing model", event: { ...GOOD_EVENT, model: "" }, message: "Supabase returned an invalid AI model" },
      { name: "negative input tokens", event: { ...GOOD_EVENT, inputTokens: -1 }, message: "Supabase returned an invalid input token count" },
      { name: "negative output tokens", event: { ...GOOD_EVENT, outputTokens: -1 }, message: "Supabase returned an invalid output token count" },
      { name: "negative cache creation tokens", event: { ...GOOD_EVENT, cacheCreationInputTokens: -1 }, message: "Supabase returned an invalid cache creation token count" },
      { name: "negative 5-minute cache creation tokens", event: { ...GOOD_EVENT, cacheCreation5mInputTokens: -1 }, message: "Supabase returned an invalid 5-minute cache creation token count" },
      { name: "negative 1-hour cache creation tokens", event: { ...GOOD_EVENT, cacheCreation1hInputTokens: -1 }, message: "Supabase returned an invalid 1-hour cache creation token count" },
      { name: "negative cache read tokens", event: { ...GOOD_EVENT, cacheReadInputTokens: -1 }, message: "Supabase returned an invalid cache read token count" },
      { name: "unparseable occurredAt", event: { ...GOOD_EVENT, occurredAt: "not-a-date" }, message: "Supabase returned an invalid AI cost occurrence timestamp" },
      { name: "unparseable recordedAt", event: { ...GOOD_EVENT, recordedAt: "not-a-date" }, message: "Supabase returned an invalid AI cost record timestamp" },
    ];
    for (const { name, event, message } of cases) {
      const { fn } = fakeSupabase({
        "/rpc/record_ai_cost_event_with_identity": { inserted: true, event, coverage: null },
      });
      globalThis.fetch = fn;
      const errors = captureErrors();
      try {
        const result = await tracking.recordAnthropicMessageCost(RECORD_COST_INPUT);
        assert.equal(result, false, `${name}: a malformed replica must not be reported as a success`);
        // endsWith, not includes: "AI cost event" is itself a prefix of "AI
        // cost event id", so a substring check alone cannot tell a field's
        // own validation apart from a different field's — which is exactly
        // what "event is a primitive" needs distinguished from "missing id".
        assert.ok(
          errors.lines.some((line) => line.endsWith(message)),
          `${name}: expected an error ending with "${message}", got: ${JSON.stringify(errors.lines)}`,
        );
      } finally {
        errors.restore();
      }
    }
  });
});

test("a numeric cost amount with more than one integer digit and no decimal point is accepted", async () => {
  // Discriminates \\d+ from \\d (needs 2+ integer digits) and an optional
  // decimal group from a mandatory one (needs none at all) at once.
  await withEnv({ ...SUPABASE_CONFIG, CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    const { fn } = fakeSupabase({
      "/rpc/record_ai_cost_event_with_identity": { inserted: true, event: { ...GOOD_EVENT, costUsd: "42" }, coverage: null },
    });
    globalThis.fetch = fn;
    assert.equal(await tracking.recordAnthropicMessageCost(RECORD_COST_INPUT), true);
  });
});

test("providerRequestId is trimmed before use, and whitespace-only is the same as empty", async () => {
  await withEnv(SUPABASE_CONFIG, async () => {
    const errors = captureErrors();
    try {
      const result = await tracking.recordAnthropicMessageCost({ ...RECORD_COST_INPUT, providerRequestId: "   " });
      assert.equal(result, false);
      assert.ok(errors.lines.some((line) => line.includes("Anthropic response has no provider request id")));
    } finally {
      errors.restore();
    }
  });
});

test("the plain (non-identity) RPC is sent the trimmed id and the calculated cost, not an empty body", async () => {
  await withEnv(SUPABASE_CONFIG, async () => {
    const { fn, calls } = fakeSupabase({ "/rpc/record_ai_cost_event": true });
    globalThis.fetch = fn;
    const result = await tracking.recordAnthropicMessageCost({
      ...RECORD_COST_INPUT,
      providerRequestId: "  msg_needs_trimming  ",
    });
    assert.equal(result, true);
    assert.equal(calls.length, 1, "default mode must not also call the _with_identity endpoint");
    assert.ok(calls[0].url.endsWith("/rpc/record_ai_cost_event"));
    assert.equal(calls[0].body.p_provider_request_id, "msg_needs_trimming");
    assert.equal(calls[0].body.p_route, "chat");
    assert.equal(calls[0].body.p_model, "claude-haiku-4-5");
    assert.equal(calls[0].body.p_input_tokens, 10);
    assert.equal(calls[0].body.p_output_tokens, 5);
    assert.equal(calls[0].body.p_occurred_at, "2026-08-14T00:00:00.000Z");
    assert.ok(typeof calls[0].body.p_cost_usd === "string" && calls[0].body.p_cost_usd.length > 0);
  });
});

test("a returned provider request id that does not match the caller's is refused", async () => {
  await withEnv({ ...SUPABASE_CONFIG, CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    const { fn } = fakeSupabase({
      "/rpc/record_ai_cost_event_with_identity": {
        inserted: true,
        event: { ...GOOD_EVENT, providerRequestId: "a-completely-different-id" },
        coverage: null,
      },
    });
    globalThis.fetch = fn;
    const errors = captureErrors();
    try {
      const result = await tracking.recordAnthropicMessageCost(RECORD_COST_INPUT);
      assert.equal(result, false);
      assert.ok(errors.lines.some((line) => line.includes("Supabase returned a different provider request id")));
    } finally {
      errors.restore();
    }
  });
});

test("a matching provider request id in the identity reply is accepted, and its D1 mirror failure is logged in full", async () => {
  await withEnv({ ...SUPABASE_CONFIG, CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    const { fn } = fakeSupabase({
      "/rpc/record_ai_cost_event_with_identity": { inserted: true, event: GOOD_EVENT, coverage: null },
    });
    globalThis.fetch = fn;
    const errors = captureErrors();
    try {
      // A successful Supabase write must still report true even though there
      // is no D1 binding here for the mirror to reach — that half is this
      // function's own business, not the caller's.
      assert.equal(await tracking.recordAnthropicMessageCost(RECORD_COST_INPUT), true);
      assert.ok(
        errors.lines.some((line) => line.includes("Cloudflare event replica: Error: D1 did not accept the AI cost event replica")),
        `expected the specific event-replica failure detail, got: ${JSON.stringify(errors.lines)}`,
      );
    } finally {
      errors.restore();
    }
  });
});

test("an inserted flag that is not a boolean is refused, not coerced", async () => {
  await withEnv({ ...SUPABASE_CONFIG, CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    const { fn } = fakeSupabase({
      "/rpc/record_ai_cost_event_with_identity": { inserted: "yes", event: GOOD_EVENT, coverage: null },
    });
    globalThis.fetch = fn;
    const errors = captureErrors();
    try {
      const result = await tracking.recordAnthropicMessageCost(RECORD_COST_INPUT);
      assert.equal(result, false);
      assert.ok(errors.lines.some((line) => line.includes("Supabase returned an invalid AI cost write result")));
    } finally {
      errors.restore();
    }
  });
});

test("a null identity reply is refused the same way a missing `inserted` flag is, not by crashing", async () => {
  await withEnv({ ...SUPABASE_CONFIG, CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    const { fn } = fakeSupabase({ "/rpc/record_ai_cost_event_with_identity": null });
    globalThis.fetch = fn;
    const errors = captureErrors();
    try {
      const result = await tracking.recordAnthropicMessageCost(RECORD_COST_INPUT);
      assert.equal(result, false);
      assert.ok(errors.lines.some((line) => line.includes("Supabase returned an invalid AI cost write result")));
    } finally {
      errors.restore();
    }
  });
});

test("a null coverage in the identity reply is not treated as one to mirror", async () => {
  await withEnv({ ...SUPABASE_CONFIG, CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    const { fn } = fakeSupabase({
      "/rpc/record_ai_cost_event_with_identity": { inserted: true, event: GOOD_EVENT, coverage: null },
    });
    globalThis.fetch = fn;
    const errors = captureErrors();
    try {
      assert.equal(await tracking.recordAnthropicMessageCost(RECORD_COST_INPUT), true);
      assert.ok(
        !errors.lines.some((line) => line.includes("coverage replica")),
        `a null coverage must not be validated or mirrored at all: ${JSON.stringify(errors.lines)}`,
      );
    } finally {
      errors.restore();
    }
  });
});

test("an absent coverage key in the identity reply is not treated as one to mirror", async () => {
  await withEnv({ ...SUPABASE_CONFIG, CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    const { fn } = fakeSupabase({
      "/rpc/record_ai_cost_event_with_identity": { inserted: true, event: GOOD_EVENT },
    });
    globalThis.fetch = fn;
    const errors = captureErrors();
    try {
      assert.equal(await tracking.recordAnthropicMessageCost(RECORD_COST_INPUT), true);
      assert.ok(!errors.lines.some((line) => line.includes("coverage replica")));
    } finally {
      errors.restore();
    }
  });
});

test("a present coverage in the identity reply is validated and an unreachable D1 is logged, not silently dropped", async () => {
  await withEnv({ ...SUPABASE_CONFIG, CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    const { fn } = fakeSupabase({
      "/rpc/record_ai_cost_event_with_identity": {
        inserted: true,
        event: GOOD_EVENT,
        coverage: {
          source: "provider_console",
          startsAt: "2026-01-01T00:00:00.000Z",
          historicalComplete: true,
          recordedAt: "2026-08-14T00:00:00.000Z",
        },
      },
    });
    globalThis.fetch = fn;
    const errors = captureErrors();
    try {
      const result = await tracking.recordAnthropicMessageCost(RECORD_COST_INPUT);
      // The write itself still succeeds — a D1 mirror problem is this
      // function's own business, never the learner's.
      assert.equal(result, true);
      assert.ok(
        errors.lines.some((line) => line.includes("Cloudflare coverage replica: Error: D1 did not accept the AI cost coverage replica")),
        `expected the specific coverage-replica failure detail, got: ${JSON.stringify(errors.lines)}`,
      );
    } finally {
      errors.restore();
    }
  });
});

test("the D1-only write path is used instead of Supabase once the domain override says so, and fails closed without a binding", async () => {
  await withEnv({ ...SUPABASE_CONFIG, CLOUDFLARE_DATA_MODE_AI_COST_WRITE_AUTHORITY: "cloudflare" }, async () => {
    // SUPABASE_CONFIG is set here specifically so that, were the domain
    // override ignored, a fall-through to the plain Supabase RPC would
    // actually reach fakeSupabase's fetch (and be counted) instead of dying
    // earlier on "accounts backend is not configured" — which would make
    // `calls.length === 0` true for the wrong reason.
    const { fn, calls } = fakeSupabase({});
    globalThis.fetch = fn;
    const errors = captureErrors();
    try {
      const result = await tracking.recordAnthropicMessageCost(RECORD_COST_INPUT);
      assert.equal(result, false);
      assert.equal(calls.length, 0, "the D1-only branch must never fall through to a Supabase RPC");
      assert.ok(errors.lines.some((line) => line.includes("recordAnthropicMessageCost")));
    } finally {
      errors.restore();
    }
  });
});

/* --------------------------------------------------------- setAiCostCoverage */

const SET_COVERAGE_INPUT = {
  source: "provider_console",
  startsAt: new Date("2026-08-01T00:00:00.000Z"),
  historicalComplete: true,
};

test("a malformed Supabase coverage replica is refused with a field-specific reason", async () => {
  await withEnv({ ...SUPABASE_CONFIG, CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    const goodCoverage = {
      source: "provider_console",
      startsAt: "2026-01-01T00:00:00.000Z",
      historicalComplete: true,
      recordedAt: "2026-08-14T00:00:00.000Z",
    };
    const cases = [
      { name: "coverage missing entirely", coverage: null, message: "Supabase returned an invalid AI cost coverage" },
      { name: "unknown source", coverage: { ...goodCoverage, source: "made-up" }, message: "Supabase returned an invalid AI cost coverage source" },
      { name: "historicalComplete is not boolean", coverage: { ...goodCoverage, historicalComplete: "yes" }, message: "Supabase returned an invalid AI cost coverage state" },
      { name: "unparseable startsAt", coverage: { ...goodCoverage, startsAt: "not-a-date" }, message: "Supabase returned an invalid AI cost coverage start" },
      { name: "unparseable recordedAt", coverage: { ...goodCoverage, recordedAt: "not-a-date" }, message: "Supabase returned an invalid AI cost coverage record timestamp" },
    ];
    for (const { name, coverage, message } of cases) {
      const { fn } = fakeSupabase({ "/rpc/set_ai_cost_coverage_with_identity": coverage });
      globalThis.fetch = fn;
      const errors = captureErrors();
      try {
        const result = await tracking.setAiCostCoverage(SET_COVERAGE_INPUT);
        assert.equal(result, false, `${name}: a malformed coverage replica must not be reported as a success`);
        assert.ok(
          errors.lines.some((line) => line.endsWith(message)),
          `${name}: expected an error containing "${message}", got: ${JSON.stringify(errors.lines)}`,
        );
      } finally {
        errors.restore();
      }
    }
  });
});

test("a well-formed coverage is accepted for either legitimate source, D1 failure included", async () => {
  await withEnv({ ...SUPABASE_CONFIG, CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    for (const source of ["provider_console", "local_tracking"]) {
      const { fn } = fakeSupabase({
        "/rpc/set_ai_cost_coverage_with_identity": {
          source,
          startsAt: "2026-01-01T00:00:00.000Z",
          historicalComplete: true,
          recordedAt: "2026-08-14T00:00:00.000Z",
        },
      });
      globalThis.fetch = fn;
      const errors = captureErrors();
      try {
        const result = await tracking.setAiCostCoverage({ ...SET_COVERAGE_INPUT, source });
        // A D1 mirror problem must not turn an accepted Supabase write into a
        // reported failure — the Supabase write is what setAiCostCoverage
        // itself is answerable for. But the attempt must actually have been
        // made (and have failed, with no D1 binding here) rather than
        // silently skipped.
        assert.equal(result, true, `source=${source}`);
        assert.ok(
          errors.lines.some((line) => line.includes("Cloudflare coverage replica: Error: D1 did not accept the AI cost coverage replica")),
          `source=${source}: expected the specific coverage-replica failure detail, got: ${JSON.stringify(errors.lines)}`,
        );
      } finally {
        errors.restore();
      }
    }
  });
});

test("an invalid coverage start timestamp on the caller's own input is refused before any request", async () => {
  await withEnv(SUPABASE_CONFIG, async () => {
    const { fn, calls } = fakeSupabase({});
    globalThis.fetch = fn;
    const errors = captureErrors();
    try {
      const result = await tracking.setAiCostCoverage({
        ...SET_COVERAGE_INPUT,
        startsAt: new Date("not-a-real-date"),
      });
      assert.equal(result, false);
      assert.equal(calls.length, 0, "an invalid input must never reach the network at all");
      assert.ok(errors.lines.some((line) => line.includes("Invalid coverage timestamp")));
    } finally {
      errors.restore();
    }
  });
});

test("the plain (non-identity) coverage RPC is sent the caller's own arguments untouched", async () => {
  await withEnv(SUPABASE_CONFIG, async () => {
    const { fn, calls } = fakeSupabase({ "/rpc/set_ai_cost_coverage": true });
    globalThis.fetch = fn;
    const result = await tracking.setAiCostCoverage(SET_COVERAGE_INPUT);
    assert.equal(result, true);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/rpc/set_ai_cost_coverage"));
    assert.equal(calls[0].body.p_source, "provider_console");
    assert.equal(calls[0].body.p_starts_at, "2026-08-01T00:00:00.000Z");
    assert.equal(calls[0].body.p_historical_complete, true);
  });
});

/* ------------------------------------------------------ readAdminAiCostSnapshot */

test("readAdminAiCostSnapshot clamps its day count before asking Supabase, rather than passing it through raw", async () => {
  await withEnv(SUPABASE_CONFIG, async () => {
    const cases = [
      { days: 0, expected: 1 },
      { days: 500, expected: 366 },
      { days: Number.NaN, expected: 30 },
      { days: undefined, expected: 30 },
      { days: 45, expected: 45 },
    ];
    for (const { days, expected } of cases) {
      const { fn, calls } = fakeSupabase({
        "/rpc/admin_ai_cost_snapshot": {
          source: "local_cost_ledger",
          currency: "USD",
          asOf: "2026-08-14T00:00:00.000Z",
          periodDays: expected,
          coverage: { source: null, startsAt: null, historicalComplete: false, includesProviderBackfill: false },
          lifetime: {}, period: {}, daily: [],
        },
      });
      globalThis.fetch = fn;
      await (days === undefined ? tracking.readAdminAiCostSnapshot() : tracking.readAdminAiCostSnapshot(days));
      assert.equal(calls.length, 1, `days=${days}`);
      assert.ok(calls[0].url.endsWith("/rpc/admin_ai_cost_snapshot"), `days=${days}`);
      assert.deepEqual(calls[0].body, { p_days: expected }, `days=${days}`);
    }
  });
});

test("the D1 read path is used once the domain override says reads come from Cloudflare, and it is not the Supabase RPC", async () => {
  await withEnv({ CLOUDFLARE_DATA_MODE_AI_COST_WRITE_AUTHORITY: "cloudflare" }, async () => {
    const { fn, calls } = fakeSupabase({});
    globalThis.fetch = fn;
    // No Cloudflare bindings are faked, so the D1 reader fails closed — but it
    // must be *that* failure, never a silent fall-through to Supabase.
    await assert.rejects(
      () => tracking.readAdminAiCostSnapshot(30),
      /Cloudflare data bindings are unavailable/,
    );
    assert.equal(calls.length, 0, "a Cloudflare-authoritative read must never also ask Supabase");
  });
});

test("without the domain override, the read still goes to Supabase even while the write side is dual", async () => {
  await withEnv({ ...SUPABASE_CONFIG, CLOUDFLARE_DATA_MODE: "dual" }, async () => {
    const { fn, calls } = fakeSupabase({
      "/rpc/admin_ai_cost_snapshot": {
        source: "local_cost_ledger", currency: "USD", asOf: "2026-08-14T00:00:00.000Z", periodDays: 30,
        coverage: { source: null, startsAt: null, historicalComplete: false, includesProviderBackfill: false },
        lifetime: {}, period: {}, daily: [],
      },
    });
    globalThis.fetch = fn;
    const snapshot = await tracking.readAdminAiCostSnapshot(30);
    assert.equal(snapshot.source, "local_cost_ledger");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/rpc/admin_ai_cost_snapshot"));
  });
});
