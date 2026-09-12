import speakingData from "@/data/speaking-topics.json";
import type { SpeakingCueCard, SpeakingPart1Topic, SpeakingTopicsData } from "@/lib/types";
import {
  PROBE_NUDGES,
  examinerFollowUp,
  examinerNudge,
  examinerQuestion,
  type ExaminerQuestion,
  type NudgeKind,
  type SpeakingPart,
  type TurnEndReason,
} from "@/lib/speaking/turn-control";

const data = speakingData as SpeakingTopicsData;

/*
  The examiner's voice, and the model that has to produce it.

  These are exported together because either one alone is a half-truth. The
  name "athena" is a British voice on @cf/deepgram/aura-1 and an American one
  on @cf/deepgram/aura-2-en, and it is not the only name the two models share
  with a different accent behind it. Pinning the model beside the speaker means
  the route cannot be pointed somewhere else without this line coming with it,
  which is the only reliable protection against recasting the whole speaking
  interview by editing a string in a file that never mentions a voice. Both
  enums are in worker-configuration.d.ts, generated from Cloudflare's own model
  schemas; a name outside the one for the model in hand does not fall back to a
  default, it fails generation with AiError 5006 and the learner hears nothing.

  This was asteria, which is American, and it made the speaking interview the
  single place in the app that left British English — while lib/speech.ts sets
  en-GB on every device utterance it asks for and lib/neural-speech.ts
  downloads a British voice on purpose. Aura-1 offers exactly two British
  voices, athena and helios, and athena is the mature feminine one, which is
  the closer match to an examiner than a young-sounding voice would be.

  The version moved with the voice, and had to. An examiner cache key carries
  the version and the hash of the words, but not the speaker, so leaving the
  version alone would have kept serving the American recordings already in R2
  for prompts whose wording has not changed. Anything that changes how a prompt
  sounds without changing what it says has to change this string.
*/
export const EXAMINER_AUDIO_MODEL = "@cf/deepgram/aura-1";
export const BUNDLED_EXAMINER_AUDIO_VERSION = "aura-1-v2";
export const BUNDLED_EXAMINER_AUDIO_VOICE = "athena";

export interface BundledExaminerAudio {
  id: string;
  text: string;
  contentVersion: typeof BUNDLED_EXAMINER_AUDIO_VERSION;
  voice: typeof BUNDLED_EXAMINER_AUDIO_VOICE;
  contentHash: string;
  cacheKey: string;
}

function stableContentHash(text: string): string {
  // This is a content-version key, not a security decision. The route only
  // accepts IDs registered below, so callers cannot turn it into arbitrary
  // billable text-to-speech.
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function questionKey(question: ExaminerQuestion): string {
  return `${question.part}\u0000${question.question}`;
}

const staticQuestionIds = new Map<string, string>();
for (const [topicIndex, topic] of data.part1.entries()) {
  for (const [questionIndex, question] of topic.questions.entries()) {
    staticQuestionIds.set(questionKey({ part: 1, question }), `p1-${topicIndex}-${questionIndex}`);
  }
}
for (const card of data.part2) {
  staticQuestionIds.set(questionKey({ part: 2, question: card.cueCard }), `p2-${card.id}`);
  /*
    And the question that closes the long turn.

    SpeakingSession asks it — `card.followUp?.[0]`, the short "Do you still see
    this person often?" an examiner uses to round off Part 2 — but this
    catalogue did not know it existed, so it had no recording and no id. The
    consequence was not one line in the wrong voice. Every id downstream of it
    carries the step's index, and the interview the candidate hears has this
    step while the interview this file enumerated did not, so from the cue card
    onward the app asked for `...-natural-pause-8` while the bucket held
    `...-natural-pause-7`. Five of the twelve transitions missed, and the
    examiner changed voice for the whole back half of the interview.

    Registered as part 2 because that is the part the examiner is still in when
    they ask it, which is the same reason SpeakingSession pushes it as part 2.
  */
  const roundingOff = card.followUp?.[0];
  if (roundingOff) {
    staticQuestionIds.set(questionKey({ part: 2, question: roundingOff }), `p2-${card.id}-round`);
  }
}
for (const [topicIndex, topic] of data.part3.entries()) {
  for (const [questionIndex, question] of topic.questions.entries()) {
    staticQuestionIds.set(questionKey({ part: 3, question }), `p3-${topicIndex}-${questionIndex}`);
  }
}

function interviewFrom(
  first: SpeakingPart1Topic,
  second: SpeakingPart1Topic,
  card: SpeakingCueCard,
): ExaminerQuestion[] | null {
  const discussion = data.part3.find((topic) => topic.topic === card.topic);
  if (!discussion) return null;
  return [
    ...first.questions.slice(0, 3).map((question) => ({ part: 1 as const, question })),
    ...second.questions.slice(0, 3).map((question) => ({ part: 1 as const, question })),
    { part: 2 as const, question: card.cueCard },
    /*
      The rounding-off question, in the same position SpeakingSession puts it
      (components/speaking/SpeakingSession.tsx). These two lists have to agree
      step for step: this one decides which recordings exist, that one decides
      which recordings are asked for, and a bridge id ends in the index of the
      step it bridges from. A step present in one and absent from the other
      does not lose one line, it renumbers every line after it.
    */
    ...(card.followUp?.[0] ? [{ part: 2 as const, question: card.followUp[0] }] : []),
    ...discussion.questions.slice(0, 4).map((question) => ({ part: 3 as const, question })),
  ];
}

/*
  Enough interviews to reach every prompt, rather than all of them.

  A prompt is named after the question it speaks, and a bridge after that
  question plus the one it hands over to. No prompt is therefore named after
  all three of (first Part 1 topic, second Part 1 topic, cue card) at once: the
  only bridge spanning two Part 1 topics is the one leaving the first topic's
  last question, and the only bridge spanning a topic and a card is the one
  leaving Part 1 for Part 2. Walking those two pairings separately registers
  exactly what the full cross product of every ordered topic pair with every
  cue card would, for a fraction of the work — and the speaking tests walk that
  cross product to prove it.
*/
function coveringInterviews(): ExaminerQuestion[][] {
  const interviews: ExaminerQuestion[][] = [];
  // Any card with a discussion behind it completes the shape of an interview
  // whose Part 1 pairing is the part being enumerated.
  const spareCard = data.part2.find((card) =>
    data.part3.some((topic) => topic.topic === card.topic),
  );
  if (data.part1.length < 2 || !spareCard) return interviews;

  for (const [secondIndex, second] of data.part1.entries()) {
    // Both roles of every ordered topic pair, and the bridge across them.
    for (const [firstIndex, first] of data.part1.entries()) {
      if (firstIndex === secondIndex) continue;
      const interview = interviewFrom(first, second, spareCard);
      if (interview) interviews.push(interview);
    }
    // Every card behind every topic, for the bridge out of Part 1. With the
    // card come its cue card, its Part 3 discussion, and their own bridges.
    const partner = data.part1[secondIndex === 0 ? 1 : 0];
    for (const card of data.part2) {
      const interview = interviewFrom(partner, second, card);
      if (interview) interviews.push(interview);
    }
  }
  return interviews;
}

const catalog = new Map<string, BundledExaminerAudio>();

function register(id: string, text: string): void {
  if (catalog.has(id)) return;
  const safeId = id.replace(/[^a-z0-9-]/giu, "-");
  const contentHash = stableContentHash(text);
  catalog.set(id, {
    id,
    text,
    contentVersion: BUNDLED_EXAMINER_AUDIO_VERSION,
    voice: BUNDLED_EXAMINER_AUDIO_VOICE,
    contentHash,
    cacheKey: `public/audio/examiner/${BUNDLED_EXAMINER_AUDIO_VERSION}/${safeId}-${contentHash}.mp3`,
  });
}

/*
  An ID names a prompt, and a prompt is one fixed piece of speech, so the same
  ID can only ever have been registered with the same text. That is what lets
  the resolvers below build an ID from the question in hand instead of
  remembering one per interview, in a table that grew with the cross product
  rather than with the catalogue it pointed into.
*/
function questionAudioId(currentId: string, startsPart: boolean): string {
  return `question-${currentId}-${startsPart ? "intro" : "plain"}`;
}

function followUpAudioId(
  currentId: string,
  nextId: string,
  nextStartsPart: boolean,
  reason: TurnEndReason,
  index: number,
): string {
  return `followup-${currentId}-${nextId}-${nextStartsPart ? "intro" : "plain"}-${reason}-${index}`;
}

/*
  The examiner's nudge, when an answer has dried up.

  Ten entries, and deliberately outside the loop below: a nudge is a fixed line
  belonging to a part, not to a question, so it does not multiply with the
  interviews the way a bridge does. Three probes per part, plus one silent
  check — the silent line is the same in all three parts, so it is registered
  once rather than three times under three ids, which would have generated the
  same recording three times over.
*/
function nudgeAudioId(part: SpeakingPart, index: number, kind: NudgeKind): string {
  if (kind === "silent") return "nudge-silent";
  return `nudge-${part}-${Math.abs(index) % PROBE_NUDGES[part].length}`;
}

for (const part of [1, 2, 3] as const) {
  for (let index = 0; index < PROBE_NUDGES[part].length; index += 1) {
    register(nudgeAudioId(part, index, "probe"), examinerNudge(part, index, "probe"));
  }
}
register(nudgeAudioId(1, 0, "silent"), examinerNudge(1, 0, "silent"));

for (const questions of coveringInterviews()) {
  for (let index = 0; index < questions.length; index += 1) {
    const current = questions[index];
    const currentId = staticQuestionIds.get(questionKey(current));
    if (!currentId) continue;
    const startsPart = index === 0 || questions[index - 1]?.part !== current.part;
    register(questionAudioId(currentId, startsPart), examinerQuestion(questions, index));

    const next = questions[index + 1];
    const nextId = next ? staticQuestionIds.get(questionKey(next)) : undefined;
    if (next && !nextId) continue;
    for (const reason of ["natural-pause", "time-limit"] as const) {
      register(
        next && nextId
          ? followUpAudioId(currentId, nextId, next.part !== current.part, reason, index)
          : "finish",
        examinerFollowUp(questions, index, reason),
      );
    }
  }
}

/** The finite, reviewed server-audio catalogue accepted by the public route. */
export const BUNDLED_EXAMINER_AUDIO_IDS = [...catalog.keys()] as readonly string[];

export function bundledExaminerAudio(id: string | null): BundledExaminerAudio | null {
  if (!id || !(BUNDLED_EXAMINER_AUDIO_IDS as readonly string[]).includes(id)) return null;
  return catalog.get(id) ?? null;
}

/** Resolve the exact first/replay prompt for a real built-in interview. */
export function examinerQuestionAudioId(
  questions: ExaminerQuestion[],
  index: number,
): string | null {
  const current = questions[index];
  if (!current) return null;
  const currentId = staticQuestionIds.get(questionKey(current));
  if (!currentId) return null;
  const startsPart = index === 0 || questions[index - 1]?.part !== current.part;
  const id = questionAudioId(currentId, startsPart);
  return catalog.has(id) ? id : null;
}

/** Resolve a reviewed bridge plus the next prompt, never arbitrary user text. */
export function examinerFollowUpAudioId(
  questions: ExaminerQuestion[],
  currentIndex: number,
  reason: TurnEndReason,
): string | null {
  const current = questions[currentIndex];
  if (!current) return null;
  const currentId = staticQuestionIds.get(questionKey(current));
  if (!currentId) return null;

  const next = questions[currentIndex + 1];
  if (!next) return catalog.has("finish") ? "finish" : null;
  const nextId = staticQuestionIds.get(questionKey(next));
  if (!nextId) return null;

  const id = followUpAudioId(currentId, nextId, next.part !== current.part, reason, currentIndex);
  return catalog.has(id) ? id : null;
}

/** Resolve the fixed nudge line for a part, or null if it is not in the catalogue. */
export function examinerNudgeAudioId(
  part: SpeakingPart,
  index: number,
  kind: NudgeKind = "probe",
): string | null {
  const id = nudgeAudioId(part, index, kind);
  return catalog.has(id) ? id : null;
}

export function bundledExaminerAudioUrl(id: string): string {
  const source = bundledExaminerAudio(id);
  const query = new URLSearchParams({ id });
  if (source) {
    query.set("v", source.contentVersion);
    query.set("voice", source.voice);
    query.set("hash", source.contentHash);
  }
  return `/api/examiner-audio?${query.toString()}`;
}

/*
  A second cache, parallel to the one above and for the opposite reason.

  Every prompt above is fixed and known ahead of time, so its ID can be
  registered once, at import time. The live Part 3 reaction
  (app/api/speaking/examiner-line/route.ts) is neither: it is written by a
  model, for whatever a candidate just said, and nothing about it is known
  until the request is already in flight, so it cannot join the catalogue
  above. But "written fresh" does not mean "spoken once" — the system prompt
  leaves the model almost no room to vary a transition ("One sentence. Never
  more than 20 words... Neutral and professional throughout"), so the same
  short, ordinary sentence comes back for many different candidates and
  different answers. Workers AI's Free-plan Neuron ceiling has no overage —
  a call past it throws rather than queues — so paying to generate the same
  sentence a second, a hundredth, a thousandth time is exactly the waste this
  file already avoids for the fixed bank above, just for text nobody could
  know ahead of the request.

  So this keys on the words themselves rather than on an id. The model and
  the voice are folded into the hash, not left to a manually-bumped version
  string the way the catalogue above is — there is no reviewed id here for a
  person to re-version by hand on a voice change, so correctness cannot
  depend on remembering to. If either constant above ever changes, every key
  below changes with it, for free.
*/
const EXAMINER_LINE_CACHE_VERSION = "v1";

function normaliseExaminerLine(text: string): string {
  // Collapses incidental whitespace differences between two calls that asked
  // the model the same thing — never case or punctuation, which are part of
  // how Aura reads the sentence rather than noise around it.
  return text.trim().replace(/\s+/gu, " ");
}

export interface ExaminerLineAudioSource {
  text: string;
  voice: typeof BUNDLED_EXAMINER_AUDIO_VOICE;
  contentHash: string;
  cacheKey: string;
}

/** The R2 key one live Part 3 reaction would be cached under, or null for text that normalises to nothing. */
export function examinerLineAudioSource(rawText: string): ExaminerLineAudioSource | null {
  const text = normaliseExaminerLine(rawText);
  if (!text) return null;
  const contentHash = stableContentHash(
    `${EXAMINER_AUDIO_MODEL} ${BUNDLED_EXAMINER_AUDIO_VOICE} ${text}`,
  );
  return {
    text,
    voice: BUNDLED_EXAMINER_AUDIO_VOICE,
    contentHash,
    cacheKey: `public/audio/examiner-line/${EXAMINER_LINE_CACHE_VERSION}/${BUNDLED_EXAMINER_AUDIO_VOICE}-${contentHash}.mp3`,
  };
}

export interface ExaminerLineAudioBindings {
  files: R2Bucket;
  ai: Ai;
}

export type ExaminerLineAudioOutcome =
  | { ok: true; audio: ArrayBuffer; cached: boolean }
  /** The AI call itself threw — on the Free plan, almost always the daily Neuron ceiling. */
  | { ok: false; kind: "quota"; reason: string }
  /** Aura answered, but not usably: a non-OK response, no body, or an implausibly small clip. */
  | { ok: false; kind: "upstream" };

/**
 * Read one live Part 3 reaction's cached MP3 from R2, or ask Aura for one and
 * bank it under the same key so the next candidate who is told this exact
 * sentence never spends a Neuron on it.
 *
 * Deliberately its own function rather than a shared one with the three
 * routes above: each of those already earns its own shape from what it
 * caches (a byte range here, a per-segment voice there), and none of that
 * applies to a line fetched once by script and never scrubbed or replayed —
 * no Range request is ever made against a POST endpoint, and there is
 * exactly one voice to choose between.
 */
export async function synthesizeExaminerLineAudio(
  { files, ai }: ExaminerLineAudioBindings,
  rawText: string,
): Promise<ExaminerLineAudioOutcome> {
  const source = examinerLineAudioSource(rawText);
  if (!source) return { ok: false, kind: "upstream" };

  let cached: R2ObjectBody | null = null;
  try {
    cached = await files.get(source.cacheKey);
  } catch {
    cached = null;
  }
  if (cached) {
    return { ok: true, audio: await cached.arrayBuffer(), cached: true };
  }

  let generated: Response;
  try {
    generated = await ai.run(
      EXAMINER_AUDIO_MODEL,
      { text: source.text, speaker: source.voice, encoding: "mp3" },
      { returnRawResponse: true },
    );
  } catch (error) {
    return { ok: false, kind: "quota", reason: error instanceof Error ? error.message : String(error) };
  }
  if (!generated.ok || !generated.body) return { ok: false, kind: "upstream" };

  let audio: ArrayBuffer;
  try {
    audio = await generated.arrayBuffer();
  } catch {
    return { ok: false, kind: "upstream" };
  }
  if (audio.byteLength < 8) return { ok: false, kind: "upstream" };

  try {
    await files.put(source.cacheKey, audio, {
      httpMetadata: { contentType: "audio/mpeg", cacheControl: "public, max-age=31536000, immutable" },
      customMetadata: { kind: "examiner-line-audio", voice: source.voice, contentHash: source.contentHash },
    });
  } catch {
    // Same as every cached route beside this one: a write failure must not
    // make the one valid generation this candidate is owed disappear.
  }

  return { ok: true, audio, cached: false };
}
