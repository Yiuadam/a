import { NextResponse } from "next/server";
import { callClaudeJSON, hasApiKey, NO_KEY_MESSAGE } from "@/lib/anthropic";
import { checkAiUsage } from "@/lib/usage/guard";
import { clampBand } from "@/lib/band";
import { WRITING_TASK1_CRITERIA, WRITING_TASK2_CRITERIA } from "@/lib/descriptors";
import type { WritingGrade } from "@/lib/types";
import { withCors } from "@/lib/http/cors";
import { logInternal, safeJsonError } from "@/lib/auth/errors";

export const maxDuration = 60;

/** See the note where this is enforced, and lib/ai/models.ts. */
const MAX_ESSAY_CHARS = 12000;

const CRITERION = {
  type: "object",
  properties: {
    name: { type: "string" },
    band: { type: "number" },
    comment: { type: "string" },
  },
  required: ["name", "band", "comment"],
  additionalProperties: false,
};

const SCHEMA = {
  type: "object",
  properties: {
    overallBand: { type: "number" },
    criteria: { type: "array", items: CRITERION },
    strengths: { type: "array", items: { type: "string" } },
    improvements: { type: "array", items: { type: "string" } },
    rewrittenExcerpt: { type: "string" },
  },
  required: ["overallBand", "criteria", "strengths", "improvements", "rewrittenExcerpt"],
  additionalProperties: false,
};

async function handlePOST(req: Request) {
  if (!hasApiKey()) {
    return NextResponse.json({ error: NO_KEY_MESSAGE }, { status: 503 });
  }

  const denied = await checkAiUsage(req, "grade/writing");
  if (denied) return denied;

  let body: { task: 1 | 2; prompt: string; essay: string; minWords: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const { task, prompt, essay, minWords } = body ?? {};
  if (typeof prompt !== "string" || typeof essay !== "string" || (task !== 1 && task !== 2)) {
    return NextResponse.json({ error: "Missing task, prompt or essay." }, { status: 400 });
  }
  /*
    A full-length Task 2 answer is 250-350 words, so 12000 characters is about
    eight times what the exam asks for and no real candidate meets it. It is a
    cost ceiling rather than a rule about essays: the input half of what this
    request costs is exactly this number, and lib/ai/models.ts budgets against
    it. Raising it here without raising it there is caught by
    tests/ai-economics.test.mjs.
  */
  if (essay.length > MAX_ESSAY_CHARS) {
    return NextResponse.json(
      { error: "That essay is longer than the exam allows. Trim it and try again." },
      { status: 400 },
    );
  }
  const minimumWords = typeof minWords === "number" ? minWords : task === 1 ? 150 : 250;

  const criteria = task === 1 ? WRITING_TASK1_CRITERIA : WRITING_TASK2_CRITERIA;
  const wordCount = essay.trim().split(/\s+/).filter(Boolean).length;

  try {
    const grade = await callClaudeJSON<WritingGrade>({
      system: `You grade mock IELTS Writing tasks against the publicly published band descriptors. You are not an official IELTS examiner and must never describe yourself as one, as certified, or as accredited — say "this practice estimate", never "your IELTS score". Grade strictly and realistically against the band descriptors below. Most learner essays fall between band 4 and band 7 — do not inflate. Bands are whole or half numbers (e.g. 6.0, 6.5). The overall band is the average of the four criterion bands rounded to the nearest half band.

${criteria}

Under-length penalty: if the response is clearly under the minimum word count, cap Task Achievement/Task Response accordingly and mention it.`,
      user: `IELTS Writing Task ${task} prompt:
"""
${prompt}
"""

Candidate response (${wordCount} words, minimum required ${minimumWords}):
"""
${essay}
"""

Grade this response. In "criteria", give exactly four entries named ${
        task === 1
          ? '"Task Achievement", "Coherence and Cohesion", "Lexical Resource", "Grammatical Range and Accuracy"'
          : '"Task Response", "Coherence and Cohesion", "Lexical Resource", "Grammatical Range and Accuracy"'
      } with a band and a 2-3 sentence comment each, quoting short examples from the essay. Give 3 concrete strengths and 3-5 prioritised improvements. In "rewrittenExcerpt", take the weakest paragraph of the essay and rewrite it at one band higher so the candidate can see the difference.`,
      schema: SCHEMA,
      route: "grade/writing",
    });
    // The model can return an out-of-range or quarter-point band; the UI and
    // stored history must only ever see valid half bands from 1 to 9.
    return NextResponse.json({
      ...grade,
      overallBand: clampBand(grade.overallBand),
      criteria: grade.criteria.map((c) => ({ ...c, band: clampBand(c.band) })),
    });
  } catch (err) {
    /*
      The upstream message is logged, never returned. It can carry the
      model name, a request id, a rate-limit detail or a fragment of the
      key — none of which a learner can act on, and all of which describe
      how this server is built. ACCOUNTS.md, threat 7.
    */
    logInternal("grade/writing", err);
    return safeJsonError(
      "Couldn't mark your writing just now. Your essay is still here — please try again in a minute.",
      502,
    );
  }
}


/*
  CORS lives on the route now rather than in proxy.ts, which cannot run on
  Cloudflare. Same behaviour, different place — see lib/http/cors.ts.
*/
export { OPTIONS } from "@/lib/http/cors";
export const POST = withCors(handlePOST);
