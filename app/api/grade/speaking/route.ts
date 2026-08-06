import { NextResponse } from "next/server";
import { callClaudeJSON, hasApiKey, NO_KEY_MESSAGE } from "@/lib/anthropic";
import { SPEAKING_CRITERIA } from "@/lib/descriptors";
import type { SpeakingGrade } from "@/lib/types";

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
    betterAnswerExample: { type: "string" },
    pronunciationNote: { type: "string" },
  },
  required: [
    "overallBand",
    "criteria",
    "strengths",
    "improvements",
    "betterAnswerExample",
    "pronunciationNote",
  ],
  additionalProperties: false,
};

interface Turn {
  role: "examiner" | "candidate";
  part: 1 | 2 | 3;
  text: string;
}

export async function POST(req: Request) {
  if (!hasApiKey()) {
    return NextResponse.json({ error: NO_KEY_MESSAGE }, { status: 503 });
  }

  let body: { transcript: Turn[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const transcript = body.transcript;
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return NextResponse.json({ error: "Missing transcript." }, { status: 400 });
  }
  const candidateWords = transcript
    .filter((t) => t.role === "candidate")
    .map((t) => t.text)
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;
  if (candidateWords < 20) {
    return NextResponse.json(
      { error: "Not enough candidate speech to grade — answer at least a few questions first." },
      { status: 400 },
    );
  }

  const rendered = transcript
    .map((t) => `[Part ${t.part}] ${t.role === "examiner" ? "EXAMINER" : "CANDIDATE"}: ${t.text}`)
    .join("\n");

  try {
    const grade = await callClaudeJSON<SpeakingGrade>({
      system: `You are a certified IELTS Speaking examiner grading a mock speaking test from a transcript. The candidate's answers were transcribed by speech recognition, so ignore transcription artifacts (missing punctuation, occasional misheard words) unless a pattern clearly reflects the candidate's own language. Grade strictly and realistically — most learners score between band 4 and band 7. Bands are whole or half numbers. The overall band is the average of the four criterion bands rounded to the nearest half band.

${SPEAKING_CRITERIA}`,
      user: `Full mock speaking test transcript (Part 1 = interview, Part 2 = long turn from a cue card, Part 3 = discussion):

"""
${rendered}
"""

Grade the candidate. In "criteria", give exactly four entries named "Fluency and Coherence", "Lexical Resource", "Grammatical Range and Accuracy", "Pronunciation" with a band and a 2-3 sentence comment each, quoting short examples from the candidate's answers. Since you only see a transcript, estimate Pronunciation conservatively from fluency/coherence proxies and explain that limitation in "pronunciationNote". Give 3 strengths and 3-5 prioritised improvements. In "betterAnswerExample", pick the candidate's weakest answer and show a band-8 model answer to that same question (natural spoken style, 60-100 words).`,
      schema: SCHEMA,
      effort: "high",
      maxTokens: 10000,
    });
    return NextResponse.json(grade);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Grading failed.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
