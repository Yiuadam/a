import { getCloudflareContext } from "@opennextjs/cloudflare";
import { callClaudeJSON } from "@/lib/anthropic";
import { requireFeature } from "@/lib/billing/gate";
import { checkAiUsage } from "@/lib/usage/guard";
import { withCors } from "@/lib/http/cors";
import { logInternal, safeJsonError, MESSAGES } from "@/lib/auth/errors";
import { synthesizeExaminerLineAudio } from "@/lib/examiner-audio";
import speakingData from "@/data/speaking-topics.json";
import type { SpeakingTopicsData } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

const data = speakingData as SpeakingTopicsData;

/*
  What a live examiner adds to Part 3, and exactly where it stops.

  ---------------------------------------------------------------------------
  Why this exists

  lib/speaking/turn-control.ts decides *when* a turn ends and *when* the
  examiner speaks — evidence about elapsed time, word count and silence, the
  same way it always has. This route only ever supplies the *words* for one
  kind of line: the brief, reactive bridge a real examiner gives between two
  Part 3 discussion questions, in place of the five-line fixed bank
  examinerTransition draws from otherwise. Nothing about timing, turn order,
  the questions themselves, or Parts 1 and 2 changes because this route
  exists. If it is slow, unavailable, refused by quota, or simply wrong, the
  caller falls back to that fixed bank — see components/speaking/
  SpeakingSession.tsx, which never awaits this on the turn-ending path itself;
  it is fired speculatively while the candidate is still answering, so a
  network round trip never becomes a pause the exam clock did not ask for.

  ---------------------------------------------------------------------------
  Why `question` is checked against the real catalogue rather than trusted

  `answer` cannot be — it is the candidate's own transcribed speech, exactly
  as free-form as every other route that grades or discusses one. `question`
  is different: it names which Part 3 discussion question was just answered,
  and it is used to tell the model what just happened rather than treated as
  data to react to. Free text there would be a second prompt-injection surface
  on top of `answer`, for a field the caller never has a legitimate reason to
  invent — every real Part 3 turn is one of the questions already shipped in
  data/speaking-topics.json. Validating it closed removes that surface rather
  than trusting the caller not to use it.

  ---------------------------------------------------------------------------
  Why the model is never told the next question

  The bridge this route writes is spoken first; the exact next question is
  spoken second, from the same reviewed, pre-cached recording every scripted
  transition already uses (see examinerFollowUpAudioId's sibling,
  bundledExaminerAudioUrl, called from the client once this route's audio has
  played). Handing the model that question's text would risk it paraphrasing
  or previewing something the real exam asks verbatim — the exact defect a
  review of this feature named as the one that would make practice easier
  than the exam it is meant to prepare someone for. So the model is told only
  that a next question is coming, never what it is, and cannot touch its
  wording because it never sees it.

  ---------------------------------------------------------------------------
  Voice, and now caching too

  synthesizeExaminerLineAudio (lib/examiner-audio.ts) speaks this line in the
  same Aura model and the same British voice, athena, that speaks every
  scripted examiner line — enforced there rather than restated here, so a
  candidate can never tell by ear which sentence was scripted and which was
  written for them just now. It also now banks the MP3 in R2 under a key
  built from that model, that voice and the line's own words: an ad-libbed
  reaction has no catalogue id to cache against, but the same short, neutral
  handful of sentences comes back across many candidates, and Workers AI's
  Free-plan Neuron ceiling has no overage. See that function's own comment
  for why the key does not lean on a manually-bumped version the way the
  fixed catalogue does.
*/

const VALID_PART3_QUESTIONS = new Set(data.part3.flatMap((topic) => topic.questions));

const MAX_ANSWER_CHARS = 2000;
const MIN_ANSWER_CHARS = 10;

const SYSTEM_PROMPT = `You are a professional IELTS Speaking examiner conducting Part 3 of a speaking test — a discussion of general, more abstract questions connected to the Part 2 topic. The candidate has just finished answering one discussion question. Immediately after your line, a second, fixed line will ask the next discussion question — you do not write that question and must not anticipate, paraphrase, or hint at it.

Your only job is to write ONE short, natural spoken line: the brief thing a real examiner says between one answer and the next question, before that next question is asked.

Strict rules — this is a formal, timed exam, and the line must sound like part of one:
- One sentence. Never more than 20 words. A real examiner's transition takes a few seconds, not a paragraph — write for the exam's own pace, not a chatbot's.
- Neutral and professional throughout. Never evaluate, grade, praise, or comment on how well the candidate did ("well said", "good point", "that's a great answer") — a real IELTS examiner gives no indication of performance mid-test.
- Never ask a question of your own, restate the question just answered, or repeat the candidate's answer back to them.
- Never mention being an AI, a language model, or anything about how this works.
- Plain spoken English. No markdown, no bullet points, no quotation marks around the line itself.`;

function unavailable(status: number): Response {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

async function handlePOST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return unavailable(400);
  }
  if (typeof body !== "object" || body === null) return unavailable(400);
  const { question, answer } = body as Record<string, unknown>;

  if (!isNonEmptyString(question) || !VALID_PART3_QUESTIONS.has(question)) return unavailable(400);
  if (!isNonEmptyString(answer)) return unavailable(400);
  const trimmedAnswer = answer.trim();
  if (trimmedAnswer.length < MIN_ANSWER_CHARS || trimmedAnswer.length > MAX_ANSWER_CHARS) {
    return unavailable(400);
  }

  const unentitled = await requireFeature(request, "speaking-examiner");
  if (unentitled) return unentitled;
  const denied = await checkAiUsage(request, "examiner");
  if (denied) return denied;

  let line: string;
  try {
    const result = await callClaudeJSON<{ line: string }>({
      system: SYSTEM_PROMPT,
      user: `The discussion question just answered: "${question}"\n\nThe candidate's answer, transcribed by speech recognition (ignore transcription artefacts — missing punctuation, occasional misheard words):\n"""\n${trimmedAnswer}\n"""\n\nWrite your one-sentence transition now.`,
      schema: {
        type: "object",
        properties: { line: { type: "string" } },
        required: ["line"],
        additionalProperties: false,
      },
      route: "examiner",
    });
    line = result.line.trim();
  } catch (error) {
    logInternal("speaking/examiner-line", error);
    return unavailable(502);
  }
  // Emptied by a refusal or a degenerate reply is still a reply this route
  // must not try to speak — the fallback bank exists for exactly this.
  if (!line) return unavailable(502);

  let env: (CloudflareEnv & Env) | null = null;
  try {
    const context = await getCloudflareContext({ async: true });
    env = context.env as CloudflareEnv & Env;
  } catch {
    return unavailable(503);
  }
  if (!env.AI || !env.AUDIO_GENERATION_RATE_LIMITER || !env.BANDUP_FILES) return unavailable(503);

  /*
    Keyed by IP rather than by content: a candidate cannot be trusted to stop
    asking just because R2 now remembers the words underneath. What this
    catches is a client stuck in a retry loop synthesising audio nobody will
    hear — the monthly quota above already bounds how many *lines* a tier can
    write, this bounds how fast one caller can burn through them.
  */
  const client = request.headers.get("CF-Connecting-IP")?.trim() || "anonymous";
  try {
    const { success } = await env.AUDIO_GENERATION_RATE_LIMITER.limit({
      key: `examiner-line:${client}`,
    });
    if (!success) {
      return new Response(null, {
        status: 429,
        headers: { "Cache-Control": "no-store", "Retry-After": "60" },
      });
    }
  } catch {
    return unavailable(503);
  }

  const outcome = await synthesizeExaminerLineAudio({ files: env.BANDUP_FILES, ai: env.AI }, line);
  if (!outcome.ok) {
    if (outcome.kind === "quota") {
      /*
        Workers AI on the Free plan has no overage: past 10,000 Neurons a day
        every @cf/deepgram/aura call throws rather than queues, and Aura is
        the only thing this app spends Neurons on. A stack trace would tell
        the owner nothing actionable; this line names the route and the
        provider's own reason, with none of the candidate's words in it, so
        Workers Logs shows quota exhaustion for what it is instead of an
        unlabelled 500. The response mirrors it: a small JSON body a client
        can fail on cheaply, the same shape lib/billing/gate.ts and
        lib/usage/guard.ts already answer every other AI outage with.
      */
      console.error(JSON.stringify({
        message: "examiner tts unavailable",
        route: "speaking/examiner-line",
        reason: outcome.reason,
      }));
      return safeJsonError(MESSAGES.unavailable, 503);
    }
    return unavailable(502);
  }

  return new Response(outcome.audio, {
    headers: {
      "Content-Type": "audio/mpeg",
      "X-Content-Type-Options": "nosniff",
      /*
        Cached now, exactly like every other examiner clip in this app. The
        words are free text, but the system prompt leaves the model almost no
        room to vary a transition, so the same short, neutral sentence comes
        back across many candidates — see synthesizeExaminerLineAudio, which
        keys this MP3 on the model, the voice and the words rather than on a
        catalogue id. A candidate who draws a sentence someone else already
        drew costs one R2 read instead of one more Neuron-metered generation.
      */
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Examiner-Line": encodeURIComponent(line),
    },
  });
}

export { OPTIONS } from "@/lib/http/cors";
export const POST = withCors(handlePOST);
