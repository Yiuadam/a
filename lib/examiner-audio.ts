import speakingData from "@/data/speaking-topics.json";
import type { SpeakingTopicsData } from "@/lib/types";
import {
  examinerFollowUp,
  examinerQuestion,
  type ExaminerQuestion,
  type TurnEndReason,
} from "@/lib/speaking/turn-control";

const data = speakingData as SpeakingTopicsData;
export const BUNDLED_EXAMINER_AUDIO_VERSION = "aura-1-v1";
export const BUNDLED_EXAMINER_AUDIO_VOICE = "asteria";

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

function interviewKey(questions: ExaminerQuestion[]): string {
  // JSON keeps the key unambiguous even when a reviewed question contains a
  // character normally used as a delimiter.
  return JSON.stringify(questions.map((question) => [question.part, question.question]));
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

function possibleInterviews(): ExaminerQuestion[][] {
  const interviews: ExaminerQuestion[][] = [];
  for (const [firstIndex, first] of data.part1.entries()) {
    for (const [secondIndex, second] of data.part1.entries()) {
      if (firstIndex === secondIndex) continue;
      for (const card of data.part2) {
        const discussion = data.part3.find((topic) => topic.topic === card.topic);
        if (!discussion) continue;
        interviews.push([
          ...first.questions.slice(0, 3).map((question) => ({ part: 1 as const, question })),
          ...second.questions.slice(0, 3).map((question) => ({ part: 1 as const, question })),
          { part: 2 as const, question: card.cueCard },
          ...discussion.questions.slice(0, 4).map((question) => ({ part: 3 as const, question })),
        ]);
      }
    }
  }
  return interviews;
}

const catalog = new Map<string, BundledExaminerAudio>();
const questionPromptIds = new Map<string, string>();
const followUpPromptIds = new Map<string, string>();

function register(id: string, text: string): string {
  const existing = catalog.get(id);
  if (existing) return existing.id;
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
  return id;
}

for (const questions of possibleInterviews()) {
  const key = interviewKey(questions);
  for (let index = 0; index < questions.length; index += 1) {
    const current = questions[index];
    const currentId = staticQuestionIds.get(questionKey(current));
    if (!currentId) continue;
    const startsPart = index === 0 || questions[index - 1]?.part !== current.part;
    const questionId = register(
      `question-${currentId}-${startsPart ? "intro" : "plain"}`,
      examinerQuestion(questions, index),
    );
    questionPromptIds.set(`${key}|question|${index}`, questionId);

    for (const reason of ["natural-pause", "time-limit"] as const) {
      const next = questions[index + 1];
      const followUpId = next
        ? (() => {
            const nextId = staticQuestionIds.get(questionKey(next));
            if (!nextId) return null;
            const nextStartsPart = next.part !== current.part;
            return register(
              `followup-${currentId}-${nextId}-${nextStartsPart ? "intro" : "plain"}-${reason}-${index}`,
              examinerFollowUp(questions, index, reason),
            );
          })()
        : register("finish", examinerFollowUp(questions, index, reason));
      if (followUpId) followUpPromptIds.set(`${key}|followup|${index}|${reason}`, followUpId);
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
  return questionPromptIds.get(`${interviewKey(questions)}|question|${index}`) ?? null;
}

/** Resolve a reviewed bridge plus the next prompt, never arbitrary user text. */
export function examinerFollowUpAudioId(
  questions: ExaminerQuestion[],
  currentIndex: number,
  reason: TurnEndReason,
): string | null {
  return followUpPromptIds.get(
    `${interviewKey(questions)}|followup|${currentIndex}|${reason}`,
  ) ?? null;
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
