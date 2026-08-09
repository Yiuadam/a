import Anthropic from "@anthropic-ai/sdk";
import { maxOutputTokens, modelFor, type CostedRoute } from "@/lib/ai/models";

/*
  The one place this app talks to the model.

  ---------------------------------------------------------------------------
  A call names its route, not its model

  Every caller used to pass its own `maxTokens` and its own `effort`, and the
  model was a single constant shared by all of them. That put the three numbers
  that decide what a request costs — model, input size, output size — in five
  different files as incidental arguments, where nothing could add them up and
  nothing could stop one of them growing.

  Now a caller names the route it is, and the model and the output ceiling come
  from lib/ai/models.ts, which is the same file the pricing arithmetic reads.
  A route cannot ask for more tokens than its own budget allows, because it has
  no way to say so.
*/

/**
 * The model most of this app runs on.
 *
 * Kept exported because it is the honest answer to "what model is this?" for
 * anything that needs one, but no request is built from it — see `modelFor`.
 */
export const MODEL = "claude-haiku-4-5";

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export const NO_KEY_MESSAGE =
  "AI features are not configured. Add ANTHROPIC_API_KEY to .env.local (see .env.example) and restart the server.";

interface CallOptions {
  /** Which metered route this is. Decides the model and the output ceiling. */
  route: CostedRoute;
  system: string;
  user: string;
  /** JSON schema for structured output (additionalProperties:false everywhere). */
  schema: Record<string, unknown>;
  /**
   * Reasoning effort, on the models that accept it.
   *
   * Silently dropped for Haiku, which rejects the parameter with a 400 rather
   * than ignoring it. Dropping it here rather than making each caller remember
   * is the difference between one rule and five chances to forget it.
   */
  effort?: "low" | "medium" | "high";
}

type AnyParams = Record<string, unknown>;

/** Only the larger models accept an effort setting. */
function acceptsEffort(model: string): boolean {
  return !model.startsWith("claude-haiku");
}

function baseParams(opts: CallOptions): AnyParams {
  const model = modelFor(opts.route);
  const outputConfig: AnyParams = {
    format: { type: "json_schema", schema: opts.schema },
  };
  if (acceptsEffort(model)) outputConfig.effort = opts.effort ?? "medium";

  return {
    model,
    max_tokens: maxOutputTokens(opts.route),
    system: opts.system,
    output_config: outputConfig,
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
