import { NextResponse } from "next/server";
import { callClaudeJSON, hasApiKey, NO_KEY_MESSAGE } from "@/lib/anthropic";
import { checkAiUsage } from "@/lib/usage/guard";
import type { ListeningTest, ReadingTest } from "@/lib/types";

export const maxDuration = 60;

const TFNG = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string", enum: ["tfng"] },
    statement: { type: "string" },
    answer: { type: "string", enum: ["TRUE", "FALSE", "NOT GIVEN"] },
  },
  required: ["id", "type", "statement", "answer"],
  additionalProperties: false,
};

const MCQ = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string", enum: ["mcq"] },
    question: { type: "string" },
    options: { type: "array", items: { type: "string" } },
    answer: { type: "integer" },
  },
  required: ["id", "type", "question", "options", "answer"],
  additionalProperties: false,
};

const COMPLETION = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string", enum: ["completion"] },
    sentence: { type: "string" },
    answer: { type: "string" },
    maxWords: { type: "integer" },
  },
  required: ["id", "type", "sentence", "answer", "maxWords"],
  additionalProperties: false,
};

const QUESTION = { anyOf: [TFNG, MCQ, COMPLETION] };

const READING_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    topic: { type: "string" },
    difficulty: { type: "string" },
    timeMinutes: { type: "integer" },
    passage: { type: "string" },
    questions: { type: "array", items: QUESTION },
  },
  required: ["id", "title", "topic", "difficulty", "timeMinutes", "passage", "questions"],
  additionalProperties: false,
};

const LISTENING_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    context: { type: "string" },
    difficulty: { type: "string" },
    timeMinutes: { type: "integer" },
    speakers: { type: "array", items: { type: "string" } },
    script: {
      type: "array",
      items: {
        type: "object",
        properties: {
          speaker: { type: "string" },
          text: { type: "string" },
        },
        required: ["speaker", "text"],
        additionalProperties: false,
      },
    },
    questions: { type: "array", items: QUESTION },
  },
  required: [
    "id",
    "title",
    "context",
    "difficulty",
    "timeMinutes",
    "speakers",
    "script",
    "questions",
  ],
  additionalProperties: false,
};

export async function POST(req: Request) {
  if (!hasApiKey()) {
    return NextResponse.json({ error: NO_KEY_MESSAGE }, { status: 503 });
  }

  const denied = await checkAiUsage(req, "generate");
  if (denied) return denied;

  let body: { kind: "reading" | "listening"; difficulty: "medium" | "hard"; topicHint?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const { kind, difficulty, topicHint } = body ?? {};
  if (kind !== "reading" && kind !== "listening") {
    return NextResponse.json({ error: "kind must be 'reading' or 'listening'." }, { status: 400 });
  }
  const level = difficulty === "hard" ? "hard (target band 6.5-8)" : "medium (target band 5-6.5)";
  const id = `gen-${kind}-${Date.now()}`;
  // The body is untrusted: only accept a string hint, and bound its length.
  const hint = typeof topicHint === "string" ? topicHint.slice(0, 200) : undefined;

  const system =
    "You are an expert IELTS exam content writer. Write ORIGINAL content that faithfully matches authentic IELTS format, register, difficulty calibration, and question style. Never reproduce real past-paper content.";

  try {
    if (kind === "reading") {
      const test = await callClaudeJSON<ReadingTest>({
        system,
        user: `Create one complete IELTS Academic Reading practice test, difficulty ${level}.${hint ? ` Topic area: ${hint}.` : " Pick a fresh academic topic (science, history, society, environment, technology)."}

Requirements:
- id: "${id}", timeMinutes: 20, difficulty: "${difficulty}"
- passage: 750-900 words of academic prose, paragraphs separated by \\n\\n
- questions: exactly 13, ids q1..q13 — 5 "tfng" (answers must include at least one each of TRUE, FALSE, NOT GIVEN), then 4 "mcq" (4 options each, answer = correct index), then 4 "completion" (sentence contains ___, answer is 1-2 words appearing VERBATIM in the passage, maxWords set accordingly)
- Questions follow passage order within each group and test paraphrase understanding, not word-spotting.`,
        schema: READING_SCHEMA,
        maxTokens: 16000,
      });
      return NextResponse.json({ kind, test });
    }

    const test = await callClaudeJSON<ListeningTest>({
      system,
      user: `Create one complete IELTS Listening practice test, difficulty ${level}, in the style of ${
        difficulty === "hard"
          ? "Section 4 (an academic monologue lecture by one speaker, 12-18 paragraph-length chunks, ~700-850 words, with lecture signposting)"
          : "Section 1 (an everyday transactional dialogue between two speakers, 30-45 short turns, ~600-750 words, with names spelled out, numbers, dates, and one self-correction)"
      }.${hint ? ` Topic area: ${hint}.` : ""}

Requirements:
- id: "${id}", timeMinutes: 12, difficulty: "${difficulty}"
- speakers: array of the exact speaker names used in script
- questions: exactly 10, ids q1..q10, in the order answers occur in the script — mostly "completion" (answer is 1-2 words/numbers appearing VERBATIM in the script) plus 2-3 "mcq" (3 options each)
- The script will be read aloud by text-to-speech, so write natural spoken English with no stage directions.`,
      schema: LISTENING_SCHEMA,
      maxTokens: 16000,
    });
    return NextResponse.json({ kind, test });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Generation failed.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
