import { NextResponse } from "next/server";
import { callClaudeJSON, hasApiKey, NO_KEY_MESSAGE } from "@/lib/anthropic";
import { clampBand } from "@/lib/band";
import { WRITING_TASK1_CRITERIA, WRITING_TASK2_CRITERIA } from "@/lib/descriptors";
import type { WritingGrade } from "@/lib/types";

export const maxDuration = 60;

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

export async function POST(req: Request) {
  if (!hasApiKey()) {
    return NextResponse.json({ error: NO_KEY_MESSAGE }, { status: 503 });
  }

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
  if (essay.length > 30000) {
    return NextResponse.json({ error: "Essay is too long." }, { status: 400 });
  }
  const minimumWords = typeof minWords === "number" ? minWords : task === 1 ? 150 : 250;

  const criteria = task === 1 ? WRITING_TASK1_CRITERIA : WRITING_TASK2_CRITERIA;
  const wordCount = essay.trim().split(/\s+/).filter(Boolean).length;

  try {
    const grade = await callClaudeJSON<WritingGrade>({
      system: `You are a certified IELTS Writing examiner. Grade strictly and realistically against the official band descriptors below. Most learner essays fall between band 4 and band 7 — do not inflate. Bands are whole or half numbers (e.g. 6.0, 6.5). The overall band is the average of the four criterion bands rounded to the nearest half band.

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
      effort: "high",
      maxTokens: 10000,
    });
    // The model can return an out-of-range or quarter-point band; the UI and
    // stored history must only ever see valid half bands from 1 to 9.
    return NextResponse.json({
      ...grade,
      overallBand: clampBand(grade.overallBand),
      criteria: grade.criteria.map((c) => ({ ...c, band: clampBand(c.band) })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Grading failed.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
