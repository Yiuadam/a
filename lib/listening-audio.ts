import { LISTENING_TESTS } from "./tests";

/*
  Canonical listening papers are the only strings this service may turn into
  server audio.  Keeping the catalogue here gives the Worker a hard boundary:
  the public media endpoint cannot be used as an arbitrary, billable TTS API.
*/
export const BUNDLED_LISTENING_AUDIO_VERSION = "aura-1-v3";
// Aura-1 accepts at most 2,000 characters per request. Leave a little room
// below that boundary so ordinary punctuation or future provider accounting
// changes cannot turn a complete paper into a 413 response.
export const MAX_AURA_AUDIO_CHARS = 1_800;

export const BUNDLED_LISTENING_AUDIO_IDS = LISTENING_TESTS.map((test) => test.id) as readonly string[];

// These two are the documented British Aura-1 voices: Athena is feminine and
// Helios is masculine. Further roles stay distinguishable without falling back
// to a different accent.
const BRITISH_AURA_VOICES = ["athena", "helios"] as const;
export type BundledListeningVoice = (typeof BRITISH_AURA_VOICES)[number];

export interface BundledListeningAudio {
  id: string;
  text: string;
  parts: readonly BundledListeningAudioPart[];
}

export interface BundledListeningAudioPart {
  index: number;
  turnIndex: number;
  speaker: string;
  voice: BundledListeningVoice;
  text: string;
  contentVersion: typeof BUNDLED_LISTENING_AUDIO_VERSION;
  contentHash: string;
  cacheKey: string;
}

function stableContentHash(text: string): string {
  // FNV-1a is not a security primitive. It simply changes the R2 key whenever
  // a reviewed script changes, so an old recording cannot be served for new
  // wording. The endpoint itself has no caller-controlled text.
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function splitLongTurn(text: string): string[] {
  const parts: string[] = [];
  let remaining = text.trim();
  while (remaining.length > MAX_AURA_AUDIO_CHARS) {
    const window = remaining.slice(0, MAX_AURA_AUDIO_CHARS + 1);
    const sentenceBreak = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("? "),
      window.lastIndexOf("! "),
    );
    const wordBreak = window.lastIndexOf(" ");
    const end = sentenceBreak > 0 ? sentenceBreak + 1 : wordBreak > 0 ? wordBreak : MAX_AURA_AUDIO_CHARS;
    parts.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

/** Resolve a reviewed script and its immutable, content-versioned R2 key. */
export function bundledListeningAudio(testId: string | null): BundledListeningAudio | null {
  if (!testId || !(BUNDLED_LISTENING_AUDIO_IDS as readonly string[]).includes(testId)) return null;
  const test = LISTENING_TESTS.find((candidate) => candidate.id === testId);
  if (!test) return null;

  const turns = test.script.map((turn) => turn.text.trim()).filter(Boolean);
  const text = turns.join("\n");
  if (!text) return null;
  const speakers = [...new Set(test.script.map((turn) => turn.speaker).filter(Boolean))];
  const parts: BundledListeningAudioPart[] = [];
  for (const [turnIndex, turn] of test.script.entries()) {
    const part = turn.text.trim();
    if (!part) continue;
    const speakerIndex = Math.max(0, speakers.indexOf(turn.speaker));
    const voice = BRITISH_AURA_VOICES[speakerIndex % BRITISH_AURA_VOICES.length];
    // A reviewed dialogue turn stays whole whenever possible. Two existing
    // lecture-style turns exceed Aura's hard limit, so only those are split at
    // a completed sentence (or, as a last resort, a word) while keeping their
    // same speaker and voice.
    const segments = part.length > MAX_AURA_AUDIO_CHARS ? splitLongTurn(part) : [part];
    for (const [segmentIndex, segment] of segments.entries()) {
      const contentHash = stableContentHash(segment);
      parts.push({
        index: parts.length,
        turnIndex,
        speaker: turn.speaker,
        voice,
        text: segment,
        contentVersion: BUNDLED_LISTENING_AUDIO_VERSION,
        contentHash,
        cacheKey: `public/audio/listening/${BUNDLED_LISTENING_AUDIO_VERSION}/${test.id}-turn-${turnIndex + 1}-part-${segmentIndex + 1}-${voice}-${contentHash}.mp3`,
      });
    }
  }
  if (!parts.length) return null;
  return {
    id: test.id,
    text,
    parts,
  };
}

/** Same-origin on web; `apiUrl()` supplies the deployed API origin on mobile. */
export function bundledListeningAudioUrl(testId: string, part = 0): string {
  // The browser and Cloudflare can safely cache an immutable MP3 forever only
  // when the URL changes with the reviewed script/voice generation. Without
  // this query key, an edge can keep serving an older recording after the R2
  // cache key has advanced.
  const source = bundledListeningAudio(testId);
  const segment = Number.isSafeInteger(part) && part >= 0 ? source?.parts[part] : null;
  const query = new URLSearchParams({ id: testId, part: String(part) });
  if (segment) {
    query.set("v", segment.contentVersion);
    query.set("voice", segment.voice);
    query.set("hash", segment.contentHash);
  }
  return `/api/listening-audio?${query.toString()}`;
}

export interface ByteRange {
  offset: number;
  length: number;
}

/**
 * Parse one ordinary `bytes=start-end` range. Media elements only need one
 * range; rejecting multiple/suffix-invalid values keeps the R2 operation and
 * response shape unambiguous.
 */
export function parseSingleRange(value: string | null, size: number): ByteRange | null {
  if (!value) return null;
  const match = /^bytes=(\d+)-(\d*)$/i.exec(value.trim());
  if (!match || size <= 0) return null;
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size) {
    return null;
  }
  const end = Math.min(requestedEnd, size - 1);
  if (end < start) return null;
  return { offset: start, length: end - start + 1 };
}
