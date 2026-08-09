import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-5";

/**
 * The cheaper model, for routes that do not exercise judgment.
 *
 * $3/$15 per million tokens against Opus 5's $5/$25. Generation and lookup use
 * it because their output is long and their task is well specified; marking
 * does not, because a band score a learner will act on is worth the difference.
 */
export const CHEAP_MODEL = "claude-sonnet-5";

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export const NO_KEY_MESSAGE =
  "AI features are not configured. Add ANTHROPIC_API_KEY to .env.local (see .env.example) and restart the server.";

interface CallOptions {
  system: string;
  user: string;
  /** JSON schema for structured output (additionalProperties:false everywhere). */
  schema: Record<string, unknown>;
  maxTokens?: number;
  /** Lower effort keeps latency inside serverless function limits. */
  effort?: "low" | "medium" | "high";
  /** Names the caller in the usage log, so cost can be attributed per feature. */
  label?: string;
  /**
   * Overrides MODEL for routes where the cheaper model is good enough.
   *
   * Grading is judgment work and stays on Opus 5. Writing a passage to a
   * template and defining a word are not, and they are the two routes whose
   * output is long enough for the price difference to decide whether a plan
   * makes money.
   */
  model?: string;
}

/*
  What each call actually cost, in tokens.

  Plan allowances and prices are set from an estimate of these numbers, and an
  estimate is all they can be until real traffic is measured: output dominates
  the bill, thinking bills as output, and how much of it a graded essay needs
  is not knowable by reading the prompt. One line per call is enough to replace
  the estimate with a measurement — grep the logs for [usage] and add it up.
*/
function logUsage(
  label: string,
  model: string,
  usage: { input_tokens?: number; output_tokens?: number } | null,
) {
  if (!usage) return;
  console.info(
    `[usage] ${label} model=${model} in=${usage.input_tokens ?? 0} out=${usage.output_tokens ?? 0}`,
  );
}

type AnyParams = Record<string, unknown>;

function baseParams(opts: CallOptions): AnyParams {
  return {
    model: opts.model ?? MODEL,
    max_tokens: opts.maxTokens ?? 8000,
    system: opts.system,
    output_config: {
      effort: opts.effort ?? "medium",
      format: { type: "json_schema", schema: opts.schema },
    },
    messages: [{ role: "user", content: opts.user }],
  };
}

function readResult(message: Anthropic.Message | Anthropic.Beta.BetaMessage): string {
  if (message.stop_reason === "refusal") {
    throw new Error(
      "The AI declined to process this content. Please adjust the text and try again.",
    );
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("The AI response was cut off. Please try again with a shorter input.");
  }
  const text = message.content.find((b) => b.type === "text")?.text ?? "";
  if (!text) throw new Error("Empty response from the AI.");
  return text;
}

/**
 * One call to Claude that returns schema-validated JSON.
 *
 * Structured outputs guarantee the reply parses. We also opt into server-side
 * refusal fallbacks so a rare safety-classifier decline is retried on a
 * fallback model inside the same call; if that beta is unavailable to the
 * caller's key we fall back to a plain request rather than failing.
 */
export async function callClaudeJSON<T>(opts: CallOptions): Promise<T> {
  const client = new Anthropic();
  const params = baseParams(opts);

  const label = opts.label ?? "unlabelled";
  const model = opts.model ?? MODEL;
  let text: string;
  try {
    const message = (await client.beta.messages.create({
      ...params,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    } as never)) as Anthropic.Beta.BetaMessage;
    logUsage(label, model, message.usage);
    text = readResult(message);
  } catch (err) {
    const isBetaRejection =
      err instanceof Anthropic.BadRequestError ||
      (err instanceof Anthropic.NotFoundError && true);
    if (!isBetaRejection) throw err;
    const message = (await client.messages.create(params as never)) as Anthropic.Message;
    logUsage(label, model, message.usage);
    text = readResult(message);
  }

  return JSON.parse(text) as T;
}
