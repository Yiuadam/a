import { NextResponse } from "next/server";
import { callClaudeJSON, hasApiKey } from "@/lib/anthropic";
import { checkAiUsage } from "@/lib/usage/guard";

export const maxDuration = 30;

/*
  Lookup is the one AI feature a learner will hit by accident, mid-test, just by
  selecting a word — so its unavailable message is written for them rather than
  for whoever forgot to set the key.
*/
const UNAVAILABLE =
  "Word lookup needs a connection to the AI tutor, which isn't set up here.";

const SCHEMA = {
  type: "object",
  properties: {
    partOfSpeech: { type: "string" },
    short: { type: "string" },
    example: { type: "string" },
    inContext: { type: "string" },
  },
  required: ["partOfSpeech", "short", "example", "inContext"],
  additionalProperties: false,
};

const SYSTEM = `You are a patient English tutor explaining a word or phrase to an IELTS candidate whose English is around CEFR B1.

Rules:
- Write the explanation in simple English. Assume the reader does not know advanced vocabulary — if you would need a hard word to explain a hard word, rephrase instead.
- "short": one or two sentences, at most 30 words, saying what it means.
- "example": one short natural sentence using the word or phrase. No quotation marks.
- "inContext": one sentence on how it is being used in the sentence the learner was reading. If no context was supplied, explain the most common use instead.
- "partOfSpeech": noun, verb, adjective, adverb, phrasal verb, idiom, grammar term, or phrase — whichever fits. Keep it to a few words.
- Never refuse a normal English word. If the input is not English or is not a word, say so plainly in "short".`;

export async function POST(req: Request) {
  if (!hasApiKey()) {
    return NextResponse.json({ error: UNAVAILABLE }, { status: 503 });
  }

  const denied = await checkAiUsage(req, "define");
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const raw = body as { term?: unknown; context?: unknown };
  const term = typeof raw?.term === "string" ? raw.term.trim().replace(/\s+/g, " ") : "";
  // The body is untrusted, so bound both fields before they reach the model.
  if (!term || term.length > 120) {
    return NextResponse.json(
      { error: "Select a word or a short phrase to look up." },
      { status: 400 },
    );
  }
  const context = typeof raw?.context === "string" ? raw.context.slice(0, 400) : "";

  try {
    const definition = await callClaudeJSON<{
      partOfSpeech: string;
      short: string;
      example: string;
      inContext: string;
    }>({
      system: SYSTEM,
      user: `Explain this for an IELTS learner: "${term}"${
        context ? `\n\nThey were reading this sentence: "${context}"` : ""
      }`,
      schema: SCHEMA,
      maxTokens: 1000,
      // A definition is a small, well-defined task; low effort keeps it fast.
      effort: "low",
    });
    return NextResponse.json({ definition: { term, ...definition } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Lookup failed.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
