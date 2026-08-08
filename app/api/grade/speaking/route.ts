import { NextResponse } from "next/server";
import { callClaudeJSON, hasApiKey, NO_KEY_MESSAGE } from "@/lib/anthropic";
import { checkAiUsage } from "@/lib/usage/guard";
import { clampBand } from "@/lib/band";
import { SPEAKING_CRITERIA } from "@/lib/descriptors";
import type { SpeakingGrade } from "@/lib/types";
import { withCors } from "@/lib/http/cors";
import { logInternal, safeJsonError } from "@/lib/auth/errors";

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

async function handlePOST(req: Request) {
  if (!hasApiKey()) {
    return NextResponse.json({ error: NO_KEY_MESSAGE }, { status: 503 });
  }

  const denied = await checkAiUsage(req, "grade/speaking");
  if (denied) return denied;

  let body: { transcript?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const raw = body?.transcript;
  if (!Array.isArray(raw) || raw.length === 0) {
    return NextResponse.json({ error: "Missing transcript." }, { status: 400 });
  }
  // The body is untrusted: keep only well-formed turns, and cap the total size
  // so one request cannot drive an unbounded prompt.
  const transcript: Turn[] = raw
    .filter(
      (t): t is Turn =>
        !!t &&
        typeof t === "object" &&
        typeof (t as Turn).text === "string" &&
        ((t as Turn).role === "examiner" || (t as Turn).role === "candidate"),
    )
    .slice(0, 60)
    .map((t) => ({
      role: t.role,
      part: t.part === 1 || t.part === 2 || t.part === 3 ? t.part : 1,
      text: t.text.slice(0, 4000),
    }));
  if (transcript.length === 0) {
    return NextResponse.json({ error: "Transcript is not in the expected format." }, { status: 400 });
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
    logInternal("grade/speaking", err);
    return safeJsonError(
      "Couldn't mark your speaking test just now. Your answers are still here — please try again in a minute.",
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
