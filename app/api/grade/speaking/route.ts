import { NextResponse } from "next/server";
import { callClaudeJSON, hasApiKey, NO_KEY_MESSAGE } from "@/lib/anthropic";
import { requireFeature } from "@/lib/billing/gate";
import { checkAiUsage } from "@/lib/usage/guard";
import { clampBand } from "@/lib/band";
import { SPEAKING_CRITERIA } from "@/lib/descriptors";
import type { SpeakingGrade } from "@/lib/types";
import { withCors } from "@/lib/http/cors";
import { logInternal, safeJsonError } from "@/lib/auth/errors";

export const maxDuration = 60;

/** See the notes where these are enforced, and lib/ai/models.ts. */
const MAX_TURN_CHARS = 2000;
const MAX_TRANSCRIPT_CHARS = 20000;

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
      text: t.text.slice(0, MAX_TURN_CHARS),
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

  /*
    Capped once more after rendering, and this is the cap that counts. The
    per-turn limit above bounds one turn; sixty of them still multiply, and a
    fourteen-minute interview transcribes to about 8000 characters — so 20000 is
    generous and is what lib/ai/models.ts budgets the input half of this request
    against. Trimming the *start* rather than the end keeps Part 3, which is the
    part the band descriptors discriminate on.
  */
  const rendered = transcript
    .map((t) => `[Part ${t.part}] ${t.role === "examiner" ? "EXAMINER" : "CANDIDATE"}: ${t.text}`)
    .join("\n")
    .slice(-MAX_TRANSCRIPT_CHARS);

  /*
    Practice can now be one part on its own — see SpeakingSession.tsx's
    focused sessions. The four criteria are all assessable from a single
    part's speech, so this needs no schema change, only an honest label: a
    prompt that still said "full mock speaking test" over a transcript with
    only Part 3 in it would be describing something that did not happen,
    to a model already told to grade "strictly and realistically" against
    what it is given.
  */
  const partsPresent = [...new Set(transcript.map((t) => t.part))].sort();
  const transcriptLabel =
    partsPresent.length === 3
      ? "Full mock speaking test transcript (Part 1 = interview, Part 2 = long turn from a cue card, Part 3 = discussion)"
      : `Speaking practice transcript, Part ${partsPresent.join(" and ")} only (not a full three-part test — grade the four criteria from this sample alone)`;

  const unentitled = await requireFeature(req, "grade-speaking");
  if (unentitled) return unentitled;
  const denied = await checkAiUsage(req, "grade/speaking");
  if (denied) return denied;

  try {
    const grade = await callClaudeJSON<SpeakingGrade>({
      system: `You grade mock IELTS Speaking tests against the publicly published band descriptors. You are not an official IELTS examiner and must never describe yourself as one, as certified, or as accredited — say "this practice estimate", never "your IELTS score". You are grading a mock speaking test from a transcript. The candidate's answers were transcribed by speech recognition, so ignore transcription artifacts (missing punctuation, occasional misheard words) unless a pattern clearly reflects the candidate's own language. Grade strictly and realistically — most learners score between band 4 and band 7. Bands are whole or half numbers. The overall band is the average of the four criterion bands rounded to the nearest half band.

${SPEAKING_CRITERIA}`,
      user: `${transcriptLabel}:

"""
${rendered}
"""

Grade the candidate. In "criteria", give exactly four entries named "Fluency and Coherence", "Lexical Resource", "Grammatical Range and Accuracy", "Pronunciation" with a band and a 2-3 sentence comment each, quoting short examples from the candidate's answers. Since you only see a transcript, estimate Pronunciation conservatively from fluency/coherence proxies and explain that limitation in "pronunciationNote". Give 3 strengths and 3-5 prioritised improvements. In "betterAnswerExample", pick the candidate's weakest answer and show a band-8 model answer to that same question (natural spoken style, 60-100 words).`,
      schema: SCHEMA,
      route: "grade/speaking",
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
