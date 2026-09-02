import { spokenForm } from "./speech-text";
import { LISTENING_TESTS } from "./tests";

/*
  Canonical listening papers are the only strings this service may turn into
  server audio.  Keeping the catalogue here gives the Worker a hard boundary:
  the public media endpoint cannot be used as an arbitrary, billable TTS API.
*/
export const BUNDLED_LISTENING_AUDIO_VERSION = "aura-2-v1";
// Aura accepts at most 2,000 characters per request. Leave a little room
// below that boundary so ordinary punctuation or future provider accounting
// changes cannot turn a complete paper into a 413 response.
export const MAX_AURA_AUDIO_CHARS = 1_800;

export const BUNDLED_LISTENING_AUDIO_IDS = LISTENING_TESTS.map((test) => test.id) as readonly string[];

/*
  One voice per speaker, in the order a paper introduces them, and the model
  that has to produce them.

  Both are named here, together, because the speaker field alone does not
  identify a voice. Deepgram's two Aura models share a good many names and do
  not agree about them: athena is British on @cf/deepgram/aura-1 and American
  on @cf/deepgram/aura-2-en, and asteria, arcas, orion, orpheus, luna, zeus and
  hera appear on both as well. A model string living in the route while the
  roster lived here is therefore a trap rather than a separation of concerns —
  changing one recasts every paper in the app with nothing failing anywhere and
  no error to read. Keeping them in one place means neither can move alone.

  Both enums are generated into worker-configuration.d.ts from Cloudflare's own
  model schemas, so `npm run build` now rejects a speaker this model does not
  accept. That check is worth having: the field is a validated enum, and a name
  outside it does not quietly fall back to a default, it fails generation with
  AiError 5006 and the learner gets no recording at all.

  What the cast is, and what it is not
  ------------------------------------
  This roster was athena, helios, angus and luna on Aura-1, which is two
  British voices, one Irish and one American, because Aura-1 has only two
  British voices and a four-person Part 3 needs four. The app is meant to be
  British throughout — lib/speech.ts asks every device utterance for en-GB and
  lib/neural-speech.ts downloads a British voice on purpose — so an American
  student sitting in a British seminar was the loudest remaining exception
  after the examiner, and the reason to move.

  Aura-2 does not solve it either: it has its own two British voices, pandora
  and draco, and no third. What it does have is Australian, in hyperion and
  theia. So the choice was between a cast that is British, British, Irish,
  American and one that is British, British, Australian, Australian, and the
  second one is the one with no American in it. Australia is a country IELTS
  examines in and records in; the residue here is a Commonwealth accent a
  candidate will genuinely meet on the day rather than the accent the app was
  asked to stop using. Say plainly what that leaves: the third and fourth
  speaker of a seminar are Australian, not British, and nothing on Aura can
  currently make them British without giving two people the same larynx.

  The order is pandora, draco, hyperion, theia — feminine, masculine,
  masculine, feminine, which is the alternation the old roster had, so the
  papers keep the gender pattern they were written against. What no roster can
  do is match a voice to a character: a fourth speaker gets theia whether the
  script calls him Malik or her Elena, because guessing gender from a name is
  not a thing to build. Casting properly needs a per-paper choice, and that is
  a decision about the papers rather than about this file.

  The price, which is the whole cache
  -----------------------------------
  Every recording in R2 is retired by this. The old roster kept its first two
  entries deliberately so that a paper with one or two speakers never lost its
  audio; changing the model gives that up, because a recording made by Aura-1
  cannot be served for a key that now promises Aura-2. The version above moves
  with it so the two generations can never share a key, and nothing breaks
  while they regenerate: a miss is a miss, the route generates and stores one
  MP3 per turn exactly as it does for a brand-new paper, and the learner waits
  for the provider rather than for nothing. The first listener to each paper
  pays that wait; every listener after them reads it out of R2.
*/
export const LISTENING_AUDIO_MODEL = "@cf/deepgram/aura-2-en";
export const AURA_VOICES = ["pandora", "draco", "hyperion", "theia"] as const;
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
