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
