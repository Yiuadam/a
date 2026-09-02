import { spokenForm } from "./speech-text";
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

/*
  One voice per speaker, in the order a paper introduces them.

  This was the two British voices alone, taken in turn, and for a Part 1 phone
  call that is exactly right. For a Part 3 it was not: the seminar papers have
  three or four people in them, so the third speaker was handed the first
  speaker's voice. Downloading listening-6 from the live endpoint and reading
  the voice off each of its 27 clips says it plainly — Dr Hale and Marcus are
  both Athena, Priya and Elena are both Helios. Four people, two voices, and
  the tutor sounds exactly like one of her students. Seven of the papers are
  built this way, and a Part 3 question is very often about who said what.

  Aura-1 offers only two British voices, so a third distinct speaker has to
  come from somewhere else. Angus is the documented Irish voice and is the
  smallest step away; a fourth speaker takes Luna, which Deepgram lists as a
  young adult, and is therefore the closest thing on the roster to another
  student. IELTS puts a range of native accents in front of candidates on
  purpose, so a mixed cast is defensible in a way that two people sharing a
  larynx is not.

  The first two entries are unchanged, and that is deliberate: every existing
  recording for a first or second speaker keeps its cache key, so this asks
  the provider to generate audio only for the third and fourth speakers of the
  seven papers that have them.

  The names are the `speaker` values Cloudflare's model schema accepts for
  @cf/deepgram/aura-1 — angus, asteria, arcas, orion, orpheus, athena, luna,
  zeus, perseus, helios, hera, stella — and their accents and genders are
  Deepgram's own published table for Aura-1. That field is a validated enum: a
  name outside it does not quietly fall back to the default, it fails the
  generation with AiError 5006 and the learner gets no recording at all. Add a
  voice here only after reading it off Cloudflare's own schema for the model
  this route actually calls.

  Which matters more than it sounds, because the obvious upgrade is a trap.
  @cf/deepgram/aura-2-en carries two different British voices, draco and
  pandora, and an Australian pair — a better cast for a four-way seminar than
  anything here. But athena is British in aura-1 and AMERICAN in aura-2-en,
  and several other names are shared across the two models with different
  accents. Changing the model string in app/api/listening-audio/route.ts while
  leaving these names alone would recast every paper in the app, silently, with
  nothing failing anywhere.

  The one thing this roster cannot do is match a voice to a character. A fourth
  speaker gets Luna whether the script calls him Malik or her Elena, because
  guessing gender from a name is not a thing to build. Casting properly needs a
  per-paper choice, and that is a decision about the papers rather than about
  this file.
*/
export const AURA_VOICES = ["athena", "helios", "angus", "luna"] as const;
export type BundledListeningVoice = (typeof AURA_VOICES)[number];

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

export function splitLongTurn(text: string): string[] {
  const parts: string[] = [];
  let remaining = text.trim();
  while (remaining.length > MAX_AURA_AUDIO_CHARS) {
    // Search the whole reachable window (everything a chunk could possibly
    // hold under the cap) for the last completed sentence in it, and use
    // that regardless of how much shorter than the cap it leaves this chunk.
    // A short chunk is inaudible to a listener; a boundary planted mid
    // sentence is not.
    const window = remaining.slice(0, MAX_AURA_AUDIO_CHARS + 1);
    const sentenceBreak = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("? "),
      window.lastIndexOf("! "),
    );
    let end: number;
    if (sentenceBreak !== -1) {
      end = sentenceBreak + 1;
    } else {
      // Only reached when nothing from here to the character cap ends a
      // sentence at all — in practice, one spoken sentence longer on its own
      // than Aura accepts in a single request. There is then no sentence
      // boundary left to cut on, so a word break is accepted as the sole
      // remaining option; every other split above always lands on a
      // completed sentence instead.
      const wordBreak = window.lastIndexOf(" ");
      end = wordBreak > 0 ? wordBreak : MAX_AURA_AUDIO_CHARS;
    }
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
    /*
      What Aura is asked to say, which is not quite what the paper says. See
      lib/speech-text.ts: a phone number written "07700 900426" is otherwise
      read back as nine hundred thousand four hundred and twenty-six, and a
      candidate cannot recover the digits from that. The spoken form is what
      gets hashed as well as spoken, so an improvement to those rules retires
      the recording it improves instead of leaving it cached forever.
    */
    const part = spokenForm(turn.text.trim());
    if (!part) continue;
    const speakerIndex = Math.max(0, speakers.indexOf(turn.speaker));
    const voice = AURA_VOICES[speakerIndex % AURA_VOICES.length];
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
