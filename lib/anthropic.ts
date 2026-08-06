import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-5";

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
}

type AnyParams = Record<string, unknown>;

function baseParams(opts: CallOptions): AnyParams {
  return {
    model: MODEL,
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

  let text: string;
  try {
    const message = (await client.beta.messages.create({
      ...params,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    } as never)) as Anthropic.Beta.BetaMessage;
    text = readResult(message);
  } catch (err) {
    const isBetaRejection =
      err instanceof Anthropic.BadRequestError ||
      (err instanceof Anthropic.NotFoundError && true);
    if (!isBetaRejection) throw err;
    const message = (await client.messages.create(params as never)) as Anthropic.Message;
    text = readResult(message);
  }

  return JSON.parse(text) as T;
}
