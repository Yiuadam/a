import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const root = process.cwd();
const deliveryPath = join(root, "lib", "listening-audio.ts");
const routePath = join(root, "app", "api", "listening-audio", "route.ts");
const listeningPagePath = join(root, "app", "practice", "listening", "page.tsx");
const examinerDeliveryPath = join(root, "lib", "examiner-audio.ts");
const examinerRoutePath = join(root, "app", "api", "examiner-audio", "route.ts");
const speakingSessionPath = join(root, "components", "speaking", "SpeakingSession.tsx");
const { LISTENING_TESTS } = await import(pathToFileURL(join(root, "lib", "tests.ts")).href);
const { spokenForm } = await import(pathToFileURL(join(root, "lib", "speech-text.ts")).href);
const turnControl = await import(
  pathToFileURL(join(root, "lib", "speaking", "turn-control.ts")).href,
);
const speakingTopics = JSON.parse(
  readFileSync(join(root, "data", "speaking-topics.json"), "utf8"),
);
const workerTypes = readFileSync(join(root, "worker-configuration.d.ts"), "utf8");

/*
  The speaker names a given Aura model actually accepts, read out of the
  bindings Cloudflare generates from its own model schemas rather than copied
  into this file by hand. `speaker` is a validated enum: a name outside it does
  not fall back to a default, it fails generation with AiError 5006 and the
  learner hears nothing, and there is no way to discover that from here. The
  two models also share a good many names while disagreeing about their
  accents, so a list maintained by hand is exactly the thing that goes stale
  in the direction nobody notices.
*/
function modelSpeakers(typeName) {
  const declaration = workerTypes.slice(workerTypes.indexOf(`interface ${typeName} {`));
  const speakers = /speaker\?:\s*([^;]+);/u.exec(declaration);
  assert.ok(speakers, `${typeName} must declare a speaker enum`);
  const names = [...speakers[1].matchAll(/"([a-z0-9_-]+)"/gu)].map((match) => match[1]);
  assert.ok(names.length > 1, `${typeName} must offer more than one speaker`);
  return names;
}

/*
  The voices on each model that are not American, and the accent each of them
  is. Deepgram publishes this and the model schema does not, so it has to live
  somewhere; keeping it to the non-American ones means the table only has to be
  right about the voices this app is allowed to use. Both rosters below are
  required to be drawn from it, which is what stops "athena", British on
  Aura-1 and American on Aura-2, from being carried across a model change.
*/
const NON_AMERICAN_AURA_VOICES = {
  "@cf/deepgram/aura-1": { athena: "British", helios: "British", angus: "Irish" },
  "@cf/deepgram/aura-2-en": {
    draco: "British",
    pandora: "British",
    hyperion: "Australian",
    theia: "Australian",
  },
};

async function delivery() {
  assert.ok(existsSync(deliveryPath), "missing lib/listening-audio.ts");
  return import(pathToFileURL(deliveryPath).href);
}

async function examinerDelivery() {
  assert.ok(existsSync(examinerDeliveryPath), "missing lib/examiner-audio.ts");
  return import(pathToFileURL(examinerDeliveryPath).href);
}

function sourceFrom(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${marker}`);
  return source.slice(start);
}

function normaliseWords(text) {
  return text.replace(/\s+/gu, " ").trim();
}

/* The real words of a line, which lib/speech-text.ts may never take away.
   It respaces digits and writes "1980s" out as "nineteen eighties", so
   anything attached to a number is allowed to change; a reviewed word going
   missing is a different matter, and this is what notices. Single letters are
   left out for exactly that reason — they are the stranded plural of a decade
   and the letters of a surname being spelled, never a word of the script. */
function alphabeticWords(text) {
  return (text.toLowerCase().match(/[a-z']+/gu) ?? []).filter((word) => word.length > 1);
}

function isSubsequence(needle, haystack) {
  let at = 0;
  for (const word of haystack) if (word === needle[at]) at += 1;
  return at === needle.length;
}

function readJsonc(path) {
  return JSON.parse(
    readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/(^|[^:"])\/\/.*$/gmu, "$1"),
  );
}

test("only canonical bundled listening papers produce deterministic per-turn British Aura recordings", async () => {
  const audio = await delivery();
  const canonicalIds = LISTENING_TESTS.map((paper) => paper.id);

  assert.deepEqual([...audio.BUNDLED_LISTENING_AUDIO_IDS], canonicalIds);

  const keys = new Set();
  let partCount = 0;
  for (const paper of LISTENING_TESTS) {
    const resolved = audio.bundledListeningAudio(paper.id);
    assert.ok(resolved, `${paper.id} should be an approved server-audio paper`);
    assert.equal(resolved.id, paper.id);
    assert.equal(
      resolved.text,
      paper.script.map((turn) => turn.text).join("\n"),
      `${paper.id} must be spoken from the bundled, reviewed script rather than request text`,
    );
    assert.ok(
      resolved.parts.length >= paper.script.length,
      `${paper.id} must produce at least one native MP3 for each exact dialogue turn`,
    );
    assert.deepEqual(
      audio.bundledListeningAudio(paper.id).parts,
      resolved.parts,
      "the reviewed paper must always resolve to the same ordered native recordings",
    );
    /*
      What Aura is given to say is the spoken form of the reviewed script — see
      lib/speech-text.ts, which respaces a phone number so it is read as digits
      rather than as nine hundred thousand and something. The boundary check is
      therefore against that rendering rather than against the raw script, and
      the check that no reviewed word went missing is made separately below,
      because it is the part that actually matters.
    */
    const spokenScript = paper.script
      .map((turn) => spokenForm(turn.text.trim()))
      .filter(Boolean)
      .join("\n");
    assert.equal(
      normaliseWords(resolved.parts.map((part) => part.text).join("\n")),
      normaliseWords(spokenScript),
      "per-turn recording must preserve every spoken word without moving a boundary",
    );
    assert.ok(
      isSubsequence(alphabeticWords(resolved.text), alphabeticWords(spokenScript)),
      `${paper.id} must still say every reviewed word, in order, once prepared for the synthesiser`,
    );

    const canonicalSpeakers = [...new Set(paper.script.map((turn) => turn.speaker))];
    /*
      Every voice British, which needs both models: neither has four, so the
      cast is two from each and each voice carries the model that produces it.
      A speaker name alone means nothing here — athena is British on Aura-1 and
      American on Aura-2 — so the pair is what gets checked, never the name.
    */
    const modelInterfaces = {
      "@cf/deepgram/aura-1": "Ai_Cf_Deepgram_Aura_1_Input",
      "@cf/deepgram/aura-2-en": "Ai_Cf_Deepgram_Aura_2_En_Input",
    };
    assert.equal(audio.AURA_VOICES.length, 4, "a four-person Part 3 needs four voices");
    assert.equal(
      new Set(audio.AURA_VOICES.map((v) => v.speaker)).size,
      4,
      "and four distinct ones, or a candidate cannot tell who is speaking",
    );
    for (const { speaker, model } of audio.AURA_VOICES) {
      const rosterAccents = NON_AMERICAN_AURA_VOICES[model];
      assert.ok(rosterAccents, `no reviewed accent table for ${model}`);
      assert.ok(
        modelSpeakers(modelInterfaces[model]).includes(speaker),
        `${speaker} is not a speaker ${model} accepts`,
      );
      assert.equal(
        rosterAccents[speaker],
        "British",
        `${speaker} is not British on ${model}, and the app is British throughout`,
      );
    }
    const voiceBySpeaker = new Map();
    const partsByTurn = new Map(paper.script.map((_, index) => [index, []]));
    for (const [partIndex, part] of resolved.parts.entries()) {
      assert.equal(part.index, partIndex, "audio parts must have contiguous zero-based indexes");
      assert.ok(
        Number.isInteger(part.turnIndex) && part.turnIndex >= 0 && part.turnIndex < paper.script.length,
        "every MP3 must point to an original dialogue turn",
      );
      partsByTurn.get(part.turnIndex).push(part);
      keys.add(part.cacheKey);
      partCount += 1;
      assert.equal(part.contentVersion, audio.BUNDLED_LISTENING_AUDIO_VERSION);
      assert.match(part.contentHash, /^[a-f0-9]{8}$/u);
      const query = new URLSearchParams({
        id: paper.id,
        part: String(partIndex),
        v: part.contentVersion,
        voice: part.voice,
        hash: part.contentHash,
      });
      assert.equal(audio.bundledListeningAudioUrl(paper.id, partIndex), `/api/listening-audio?${query}`);
    }

    /*
      Nobody in a paper may share a voice with anybody else in it. This is what
      the two-voice roster could not give a Part 3: with four people in the
      room the tutor and the third speaker were the same person to listen to,
      and the questions in that part are frequently about which of them said
      what.
    */
    assert.ok(
      canonicalSpeakers.length <= audio.AURA_VOICES.length,
      `${paper.id} has ${canonicalSpeakers.length} speakers and the roster holds ${audio.AURA_VOICES.length}`,
    );

    for (const [turnIndex, turn] of paper.script.entries()) {
      const turnParts = partsByTurn.get(turnIndex);
      assert.ok(turnParts?.length, `turn ${turnIndex + 1} needs a native MP3`);
      assert.equal(
        normaliseWords(turnParts.map((part) => part.text).join("\n")),
        normaliseWords(spokenForm(turn.text.trim())),
        "a turn's MP3 parts must reassemble to exactly that speaker's spoken wording",
      );
      assert.ok(
        isSubsequence(alphabeticWords(turn.text), alphabeticWords(turnParts.map((part) => part.text).join(" "))),
        `turn ${turnIndex + 1} must still say every reviewed word, in order`,
      );
      if (turn.text.trim().length <= audio.MAX_AURA_AUDIO_CHARS) {
        assert.equal(turnParts.length, 1, "an ordinary dialogue turn must remain one MP3");
      } else {
        assert.ok(turnParts.length > 1, "only an overlong monologue may be split for Aura");
      }

      const knownVoice = voiceBySpeaker.get(turn.speaker);
      const expectedVoice =
        knownVoice ??
        audio.AURA_VOICES[canonicalSpeakers.indexOf(turn.speaker) % audio.AURA_VOICES.length]
          .speaker;
      voiceBySpeaker.set(turn.speaker, expectedVoice);

      for (const [turnPartIndex, part] of turnParts.entries()) {
        assert.equal(part.turnIndex, turnIndex, "split MP3s must keep their original dialogue boundary");
        assert.equal(part.speaker, turn.speaker, "the MP3 must retain the canonical speaker identity");
        assert.equal(part.voice, expectedVoice, "a canonical speaker must retain their voice across turns");
        assert.ok(part.text.length > 0, "an empty MP3 part would create a silent gap");
        assert.ok(part.text.length <= 1_800, "Aura input must stay below its 2,000-character limit");
        assert.ok(
          audio.AURA_VOICES.some((v) => v.speaker === part.voice && v.model === part.model),
          "a recording must be cast from the paper's own voice roster, voice and model together",
        );

        // Keep the content fingerprint, turn-part boundary, and voice identity
        // in R2. A corrected line or speaker assignment may never reuse an MP3
        // rendered from the old text or the other dialogue voice.
        assert.match(
          part.cacheKey,
          new RegExp(
            `^public/audio/listening/${audio.BUNDLED_LISTENING_AUDIO_VERSION}/${paper.id}-turn-${turnIndex + 1}-part-${turnPartIndex + 1}-${part.voice}-[a-f0-9]{8,}\\.mp3$`,
          ),
        );
        assert.equal(
          audio.bundledListeningAudio(paper.id).parts[part.index].cacheKey,
          part.cacheKey,
          "the same canonical dialogue turn must resolve to the same R2 key",
        );
      }
    }

    if (canonicalSpeakers.length > 1) {
      assert.notEqual(
        voiceBySpeaker.get(canonicalSpeakers[0]),
        voiceBySpeaker.get(canonicalSpeakers[1]),
        "the first two distinct people in a dialogue must not sound like the same person",
      );
    }
  }

  assert.equal(keys.size, partCount, "dialogue turns must never share an MP3 object");
  /*
    "listening-12" used to sit in this list as an id that could not exist. It
    exists now, so the negative case needs an id that genuinely never will —
    the point of the check is that an unapproved id resolves to nothing, not
    that any particular number is unused.
  */
  for (const badId of ["", "listening-999", "https://example.test/voice.mp3", "../../secret"]) {
    assert.equal(audio.bundledListeningAudio(badId), null);
  }
});

test("splitLongTurn keeps a sentence whole whenever the remaining text contains one, and only breaks on a word when it genuinely cannot", async () => {
  const audio = await delivery();
  const { splitLongTurn, MAX_AURA_AUDIO_CHARS } = audio;

  // A long run of ordinary short sentences. Every join between chunks is
  // required to land on a completed sentence — that guarantee is the whole
  // point of the fix, so a future script edit can never silently reopen a
  // mid-sentence audio boundary here.
  const sentence = "This is one reviewed sentence about the harbour museum. ";
  const manySentences = sentence.repeat(120).trim();
  assert.ok(manySentences.length > MAX_AURA_AUDIO_CHARS * 2, "fixture must force more than one split");
  const parts = splitLongTurn(manySentences);
  assert.ok(parts.length > 2, "a long run of short sentences must produce several chunks");
  for (const part of parts.slice(0, -1)) {
    assert.match(part, /[.?!]$/, "every chunk but the last must end exactly where a sentence ends");
  }
  for (const part of parts) {
    assert.ok(part.length > 0, "an empty chunk would create a silent gap");
    assert.ok(part.length <= MAX_AURA_AUDIO_CHARS, "every chunk must respect Aura's character cap");
  }
  assert.equal(
    parts.join(" ").replace(/\s+/gu, " ").trim(),
    manySentences.replace(/\s+/gu, " ").trim(),
    "splitting must not drop or duplicate a single reviewed word",
  );

  // A single spoken sentence longer than the cap has no sentence end to
  // split on at all. This is the one case a mid-sentence word break is
  // accepted, and only because the cap leaves no alternative; it must still
  // terminate rather than loop, and still respect the cap on every chunk.
  const oneGiantSentence = `${"word ".repeat(500).trim()} done`;
  assert.ok(oneGiantSentence.length > MAX_AURA_AUDIO_CHARS, "fixture must exceed the cap on its own");
  assert.doesNotMatch(oneGiantSentence, /[.?!]/, "fixture must contain no sentence end at all");
  const singleSentenceParts = splitLongTurn(oneGiantSentence);
  assert.ok(singleSentenceParts.length > 1, "an over-cap single sentence must still be split to terminate");
  for (const part of singleSentenceParts) {
    assert.ok(part.length > 0);
    assert.ok(part.length <= MAX_AURA_AUDIO_CHARS, "the word-break fallback must still respect the cap");
  }
  assert.equal(
    singleSentenceParts.join(" ").replace(/\s+/gu, " ").trim(),
    oneGiantSentence.replace(/\s+/gu, " ").trim(),
  );

  // The most extreme version of the same case: no word break either. The
  // loop must still make progress and terminate, cutting hard at the cap.
  const noBreaksAtAll = "a".repeat(MAX_AURA_AUDIO_CHARS * 2 + 137);
  const hardCutParts = splitLongTurn(noBreaksAtAll);
  assert.ok(hardCutParts.length > 1);
  for (const part of hardCutParts) {
    assert.ok(part.length > 0);
    assert.ok(part.length <= MAX_AURA_AUDIO_CHARS);
  }
  assert.equal(hardCutParts.join(""), noBreaksAtAll, "a hard cut must not drop or duplicate characters");

  // The two reviewed lecture turns that are actually long enough to split
  // today: every join between their MP3 parts must land on a completed
  // sentence, exactly like the synthetic case above.
  for (const id of ["listening-8", "listening-11"]) {
    const resolved = audio.bundledListeningAudio(id);
    const longTurnParts = resolved.parts.filter((part) => part.turnIndex === 0);
    assert.ok(longTurnParts.length > 1, `${id} turn 1 is expected to still need splitting`);
    for (const part of longTurnParts.slice(0, -1)) {
      assert.match(
        part.text,
        /[.?!]$/,
        `${id} turn 1 must never hand Aura a chunk that ends mid-sentence`,
      );
    }
  }
});

test("R2 byte range parsing is exact, supports resumable audio, and rejects ambiguous ranges", async () => {
  const { parseSingleRange } = await delivery();

  assert.deepEqual(parseSingleRange("bytes=0-3", 10), { offset: 0, length: 4 });
  assert.deepEqual(parseSingleRange("bytes=7-", 10), { offset: 7, length: 3 });
  assert.equal(parseSingleRange("bytes=10-", 10), null);
  assert.equal(parseSingleRange("bytes=4-2", 10), null);
  assert.equal(parseSingleRange("bytes=-3", 10), null);
  assert.equal(parseSingleRange("bytes=0-1,3-4", 10), null);
  assert.equal(parseSingleRange("items=0-1", 10), null);
});

test("the Worker caches one strict per-speaker listening turn as raw MP3 and faithfully answers native-audio range requests", () => {
  assert.ok(existsSync(routePath), "missing app/api/listening-audio/route.ts");
  const route = readFileSync(routePath, "utf8");

  // The route must derive its text from the strict helper. A user-controlled
  // `text` parameter would turn a public practice link into an unbounded TTS
  // endpoint paid for by BandUp.
  assert.match(route, /bundledListeningAudio\(/);
  assert.match(route, /bundledListeningAudio\(url\.searchParams\.get\("id"\)\)/);
  assert.match(route, /searchParams\.get\("part"\)/);
  assert.doesNotMatch(route, /searchParams\.get\("(?:text|prompt)"\)/);
  assert.match(route, /source\.parts\[/);
  assert.match(route, /!\/\^\\d\+\$\/u\.test\(rawPart\)/);
  assert.match(route, /part\s*<\s*0\s*\|\|\s*part\s*>=\s*source\.parts\.length/);
  assert.match(route, /unavailable\(404\)/);
  assert.match(route, /hasExactMediaTokens\(/);
  for (const token of ["v", "voice", "hash"]) {
    assert.match(route, new RegExp(`${token}: (?:segment|source)\\.`));
  }

  // Read the selected canonical chunk first; only a miss should call Workers
  // AI, then persist its raw audio with MP3 metadata for every later learner.
  assert.match(route, /BANDUP_FILES\.get\(/);
  assert.match(route, /BANDUP_FILES\.put\(/);
  /*
    The model is named beside the voices rather than here. Aura shares speaker
    names across its two models and disagrees about their accents, so a route
    that owned the model string could be repointed without the roster coming
    with it — which recasts every paper in the app and fails nowhere.
  */
  // Per segment, because the cast is drawn from two models at once.
  assert.match(route, /AI\.run\(\s*segment\.model,/);
  assert.doesNotMatch(route, /AI\.run\(\s*["']@cf\//u);
  assert.match(route, /from "@\/lib\/listening-audio"/);
  assert.match(route, /text:\s*(?:part|sourcePart|segment)\.text/);
  assert.match(
    route,
    /speaker:\s*(?:part|sourcePart|segment)\.voice/,
    "Workers AI must use the reviewed turn's Aura voice instead of one hard-coded narrator",
  );
  assert.doesNotMatch(
    route,
    /speaker:\s*["']asteria["']/,
    "a single hard-coded narrator would make both people sound too similar",
  );
  assert.match(route, /Content-Type["']?\s*[:,]\s*["']audio\/mpeg["']/);
  assert.match(route, /new Response\((?:cached(?:\.body)?|audio|speech|synthesis|body)/);
  assert.doesNotMatch(route, /(?:await\s+)?(?:audio|speech|synthesis)\.json\(/);
  assert.doesNotMatch(route, /JSON\.stringify\(\s*(?:audio|speech|synthesis)/);

  // Native <audio> asks for byte ranges during seeks and can resume interrupted
  // downloads. The stored object must be read with the parsed range and reply
  // with a real partial-content response, not a whole MP3 mislabeled as 206.
  assert.match(route, /request\.headers\.get\("Range"\)/);
  assert.match(route, /parseSingleRange\(/);
  assert.match(route, /BANDUP_FILES\.get\([^,]+,\s*range \? \{ range \} : undefined\)/);
  assert.match(route, /status:\s*206/);
  assert.match(route, /Content-Range/);
  assert.match(route, /Accept-Ranges/);

  const cacheHit = route.indexOf("if (cached)");
  const limiter = route.indexOf("AUDIO_GENERATION_RATE_LIMITER.limit");
  const generation = route.indexOf("AI.run(");
  assert.ok(cacheHit >= 0 && limiter > cacheHit, "cached MP3 reads must not spend a rate-limit token");
  assert.ok(generation > limiter, "the per-cache-key limit must be enforced before Workers AI generation");
  assert.match(route, /limit\(\{ key: segment\.cacheKey \}\)/);
  assert.match(route, /status:\s*429/);
  assert.match(route, /"Retry-After"/);
});

test("listening plays exact native dialogue turns in order, only prefetches nearby future turns, then falls back to browser speech", () => {
  const page = readFileSync(listeningPagePath, "utf8");
  const start = sourceFrom(page, "const startAudio");

  assert.match(page, /const nativeAudioRef = useRef<HTMLAudioElement/);
  assert.match(page, /const startNativeAudio/);
  assert.match(page, /const startBrowserAudio/);
  assert.match(page, /<audio[\s\S]*?data-listening-native-audio/);
  assert.match(page, /const playNativeAudioPart[\s\S]*?part:\s*number/);
  assert.match(page, /const prefetchNativeAudioParts[\s\S]*?currentPart:\s*number/);
  assert.match(page, /const startNativeAudio[\s\S]*?playNativeAudioPart\(run, from, 0\)/);
  assert.match(page, /media\.src\s*=\s*apiUrl\(bundledListeningAudioUrl\(test\.id, part\)\)/);
  assert.match(page, /onTimeUpdate=/);
  assert.match(page, /(?:currentTime|nativeAudioProgress)/);
  assert.match(page, /onEnded=/);
  assert.match(page, /onError=/);

  const nativeFirst = start.indexOf("startNativeAudio(");
  const browserFallback = start.indexOf("startBrowserAudio(");
  assert.ok(nativeFirst >= 0, "the play control must start native MP3 audio for bundled papers");
  assert.ok(browserFallback > nativeFirst, "browser speech must be the recovery path, not the default");

  const native = sourceFrom(page, "const startNativeAudio");
  assert.match(
    native,
    /(?:startBrowserAudio|browser).*?(?:onError|catch)|(?:onError|catch).*?(?:startBrowserAudio|browser)/s,
    "a failed native player must retain browser speech as the recovery route",
  );
  const ended = sourceFrom(page, "onEnded={(event)").slice(0, 1_700);
  assert.match(ended, /playNativeAudioPart\(run, nativeAudioFromRef\.current, nextPart\)/);
  assert.match(ended, /nextPart\s*<\s*nativeAudioPartCountRef\.current/);

  const prefetch = sourceFrom(page, "const prefetchNativeAudioParts").slice(0, 2_800);
  assert.match(page, /const NATIVE_AUDIO_PREFETCH_AHEAD\s*=\s*3\s*;/);
  assert.match(prefetch, /currentPart\s*\+\s*1/, "lookahead must begin after the audible current turn");
  assert.match(prefetch, /serverAudioParts\.length/, "lookahead must stop at the reviewed paper boundary");
  assert.match(
    prefetch,
    /Math\.min\(serverAudioParts\.length, currentPart \+ 1 \+ NATIVE_AUDIO_PREFETCH_AHEAD\)/,
    "only the next three dialogue turns may be warmed",
  );
  assert.match(
    prefetch,
    /for \(let part = currentPart \+ 1; part < last; part \+= 1\)/,
    "lookahead must visit future dialogue turns in their natural order",
  );
  assert.match(prefetch, /bundledListeningAudioUrl\(test\.id, (?:part|nextPart)\)/);
  assert.match(prefetch, /fetch\(/, "preloading must warm the same native MP3 endpoint");
  assert.doesNotMatch(
    prefetch,
    /serverAudioParts\.(?:map|forEach)\(/,
    "do not issue the entire paper at once; only a small turn lookahead is allowed",
  );

  const playing = sourceFrom(page, "onPlaying={() =>").slice(0, 1_300);
  assert.match(
    playing,
    /prefetchNativeAudioParts\(nativeAudioPartRef\.current\)/,
    "the player may prefetch only after the current exact dialogue turn has begun",
  );
  assert.match(page, /data-listening-native-audio[\s\S]*?preload="none"/);
});

/*
  page.tsx is a client component built around a hand-rolled media state
  machine, not a pure function — there is no harness in this suite that
  mounts React and drives real <audio> elements. The rest of this file's
  native-audio coverage already reads page.tsx as source rather than
  executing it, so the two tests below do the same for double buffering:
  they assert on the structure of the code (two elements, the buffer primed
  ahead of `ended`, the run-token guard preserved on both) rather than on
  emitted DOM events.
*/
test("listening's native player double-buffers two media elements and primes the next part before ended can fire", () => {
  const page = readFileSync(listeningPagePath, "utf8");

  // Two <audio> elements, not one: the point of double-buffering is that the
  // element about to play a part is never the one whose `src` just changed.
  assert.match(page, /const nativeAudioRef = useRef<HTMLAudioElement/);
  assert.match(page, /const nativeAudioBufferRef = useRef<HTMLAudioElement/);
  assert.equal(
    (page.match(/<audio\b/g) ?? []).length,
    2,
    "the listening player must render exactly two native <audio> elements",
  );
  assert.match(page, /ref=\{nativeAudioRef\}/);
  assert.match(page, /ref=\{nativeAudioBufferRef\}/);

  // playNativeAudioPart is the single place that both starts a part cold and
  // hands off to one already buffered on the standby element — it must
  // consult which part is already buffered before deciding it can avoid
  // reassigning `src` (the decode-pipeline rebuild double buffering exists to
  // dodge), and it must play() the standby element directly when it can.
  const player = sourceFrom(page, "const playNativeAudioPart");
  assert.match(player, /nativeAudioBufferedPartRef\.current === part/);
  assert.match(player, /standby\.play\(\)/);
  assert.match(player, /primeNativeAudioBuffer\(run, part\)/);

  // The next part is assigned and load()ed onto the standby element from
  // inside playNativeAudioPart, i.e. as soon as the current part starts —
  // strictly before that part's own `ended` event can possibly fire.
  const idxPlay = player.search(/media\.play\(\)|standby\.play\(\)/);
  const idxPrime = player.indexOf("primeNativeAudioBuffer(run, part);", idxPlay);
  assert.ok(
    idxPlay >= 0 && idxPrime > idxPlay,
    "the next part must be queued on the standby element right after the current one starts playing",
  );

  const primer = sourceFrom(page, "const primeNativeAudioBuffer");
  assert.match(primer, /standby\.src = apiUrl\(bundledListeningAudioUrl\(test\.id, nextPart\)\)/);
  assert.match(primer, /standby\.load\(\)/);
  assert.match(primer, /nativeAudioBufferedPartRef\.current = nextPart/);

  // The buffered element is allowed to preload; the JSX default of
  // preload="none" is only right for an element with nothing queued.
  assert.match(primer, /standby\.preload = "auto"/);
  assert.match(page, /data-listening-native-audio-buffer[\s\S]*?preload="none"/);
});

test("every native-audio DOM event still honours the run-token guard on both elements, and a stale element cannot resurrect playback", () => {
  const page = readFileSync(listeningPagePath, "utf8");

  // The run-token guard that already protected the single element must keep
  // gating every handler unchanged — a cancelled or superseded run stays
  // inert exactly as it did before double buffering existed — and now on
  // both elements, so ten guards (five handlers times two elements) in total.
  const guard = /const run = nativeAudioRunRef\.current;\s*\n\s*if \(!run \|\| run !== playbackRunRef\.current\) return;/g;
  assert.equal(
    (page.match(guard) ?? []).length,
    10,
    "both <audio> elements need the unchanged run-token guard on all five handlers",
  );

  // Double buffering adds a second element that can also fire events, so the
  // run-token guard alone is not sufficient: a stale or standby element must
  // not be able to advance the part index or resurrect playback either. Every
  // handler also checks identity against whichever element is presently
  // authoritative, using whichever form of the element already sits in scope
  // (the event's own currentTarget where the handler is shared, this
  // element's own ref where the handler is a zero-argument closure).
  assert.match(page, /event\.currentTarget !== nativeAudioActiveRef\.current/);
  assert.match(page, /nativeAudioRef\.current !== nativeAudioActiveRef\.current/);
  assert.match(page, /nativeAudioBufferRef\.current !== nativeAudioActiveRef\.current/);
  assert.ok(
    (page.match(/nativeAudioActiveRef\.current/g) ?? []).length >= 10,
    "every one of the ten handlers must consult the active-element identity, not only the run token",
  );

  // A fresh start, a stop, and the native/browser fallback path all forget
  // which element was active and what the standby held, so a new run can
  // never mistake a previous run's buffered element or part for its own.
  for (const marker of ["const startAudio", "const stopAudio", "const fallbackFromNativeAudio"]) {
    const scope = sourceFrom(page, marker).slice(0, 1_200);
    assert.match(scope, /nativeAudioActiveRef\.current = null/, `${marker} must forget the active element`);
    assert.match(
      scope,
      /nativeAudioBufferedPartRef\.current = -1/,
      `${marker} must forget what the standby element was holding`,
    );
  }
});

function canonicalExaminerInterviews() {
  const interviews = [];
  for (const [firstIndex, first] of speakingTopics.part1.entries()) {
    for (const [secondIndex, second] of speakingTopics.part1.entries()) {
      if (firstIndex === secondIndex) continue;
      for (const card of speakingTopics.part2) {
        const discussion = speakingTopics.part3.find((topic) => topic.topic === card.topic);
        assert.ok(discussion, `missing Part 3 discussion for ${card.topic}`);
        interviews.push([
          ...first.questions.slice(0, 3).map((question) => ({ part: 1, question })),
          ...second.questions.slice(0, 3).map((question) => ({ part: 1, question })),
          { part: 2, question: card.cueCard },
          ...discussion.questions.slice(0, 4).map((question) => ({ part: 3, question })),
        ]);
      }
    }
  }
  return interviews;
}

test("only canonical examiner questions, part introductions, and transitions resolve to server-audio IDs", async () => {
  const audio = await examinerDelivery();
  const interviews = canonicalExaminerInterviews();
  const ids = new Set(audio.BUNDLED_EXAMINER_AUDIO_IDS);

  assert.ok(ids.size > 0, "the static examiner catalogue must not be empty");
  assert.equal(ids.size, audio.BUNDLED_EXAMINER_AUDIO_IDS.length, "examiner prompt IDs must be unique");
  for (const id of ids) {
    assert.match(id, /^[a-z0-9][a-z0-9-]*$/, "prompt IDs must remain safe R2 path segments");
  }

  let partIntroCount = 0;
  let plainQuestionCount = 0;
  let followUpCount = 0;
  for (const interview of interviews) {
    for (let index = 0; index < interview.length; index += 1) {
      const current = interview[index];
      const questionId = audio.examinerQuestionAudioId(interview, index);
      assert.ok(questionId, `missing fixed question ID at interview index ${index}`);
      assert.ok(ids.has(questionId), `question ID is outside the static allowlist: ${questionId}`);
      const question = audio.bundledExaminerAudio(questionId);
      assert.ok(question, `missing bundled examiner prompt: ${questionId}`);
      assert.equal(
        question.text,
        turnControl.examinerQuestion(interview, index),
        "the cached MP3 text must exactly match the examiner's visible/spoken question",
      );
      const startsPart = index === 0 || interview[index - 1].part !== current.part;
      if (startsPart) {
        partIntroCount += 1;
        assert.match(question.text, new RegExp(turnControl.SPEAKING_PART_INTRO[current.part]));
      } else {
        plainQuestionCount += 1;
        assert.doesNotMatch(question.text, new RegExp(turnControl.SPEAKING_PART_INTRO[current.part]));
      }

      for (const reason of ["natural-pause", "time-limit"]) {
        const followUpId = audio.examinerFollowUpAudioId(interview, index, reason);
        assert.ok(followUpId, `missing ${reason} follow-up at interview index ${index}`);
        assert.ok(ids.has(followUpId), `follow-up ID is outside the static allowlist: ${followUpId}`);
        assert.equal(
          audio.bundledExaminerAudio(followUpId)?.text,
          turnControl.examinerFollowUp(interview, index, reason),
        );
        followUpCount += 1;
      }
    }
  }
  assert.ok(partIntroCount > 0, "part introductions must be represented in the fixed audio catalogue");
  assert.ok(plainQuestionCount > 0, "plain follow-on questions must be distinct fixed prompts");
  assert.ok(followUpCount > 0, "natural/time-limit transitions must be represented in the catalogue");

  const arbitrary = [{ part: 1, question: "Spend BandUp money on arbitrary speech." }];
  assert.equal(audio.examinerQuestionAudioId(arbitrary, 0), null);
  assert.equal(audio.examinerFollowUpAudioId(arbitrary, 0, "natural-pause"), null);
  assert.equal(audio.bundledExaminerAudio("prompt-from-query-string"), null);
});

test("the examiner speaks in a British voice from the model named beside it", async () => {
  const audio = await examinerDelivery();

  assert.ok(
    modelSpeakers("Ai_Cf_Deepgram_Aura_1_Input").includes(audio.BUNDLED_EXAMINER_AUDIO_VOICE),
    `${audio.BUNDLED_EXAMINER_AUDIO_VOICE} is not a speaker ${audio.EXAMINER_AUDIO_MODEL} accepts`,
  );
  /*
    The examiner is the app's own voice and has no business being American,
    which asteria was. The accent belongs to the pairing rather than to the
    name: athena is British on Aura-1 and American on Aura-2, so this reads the
    table for the model this module actually pins.
  */
  assert.equal(
    NON_AMERICAN_AURA_VOICES[audio.EXAMINER_AUDIO_MODEL]?.[audio.BUNDLED_EXAMINER_AUDIO_VOICE],
    "British",
    "the speaking examiner must not leave British English",
  );
  /*
    An examiner cache key carries the version and the hash of the words, but
    not the speaker, so a voice change that left the version alone would keep
    serving the recordings already in R2 for exactly the same prompts.
  */
  assert.notEqual(
    audio.BUNDLED_EXAMINER_AUDIO_VERSION,
    "aura-1-v1",
    "the version pinned to the American recordings must not be reused for a new voice",
  );
});

test("every cached examiner MP3 has a deterministic, content-versioned R2 key", async () => {
  const audio = await examinerDelivery();
  const keys = new Set();

  for (const id of audio.BUNDLED_EXAMINER_AUDIO_IDS) {
    const resolved = audio.bundledExaminerAudio(id);
    assert.ok(resolved, `catalogue ID ${id} must resolve`);
    assert.equal(resolved.id, id);
    assert.match(id, /^[a-z0-9][a-z0-9-]*$/);
    assert.ok(resolved.text.trim(), `${id} must not synthesize an empty prompt`);
    assert.equal(resolved.contentVersion, audio.BUNDLED_EXAMINER_AUDIO_VERSION);
    assert.equal(resolved.voice, audio.BUNDLED_EXAMINER_AUDIO_VOICE);
    assert.match(resolved.contentHash, /^[a-f0-9]{8}$/u);
    assert.match(
      resolved.cacheKey,
      new RegExp(`^public/audio/examiner/${audio.BUNDLED_EXAMINER_AUDIO_VERSION}/${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[a-f0-9]{8,}\\.mp3$`),
    );
    assert.equal(audio.bundledExaminerAudio(id)?.cacheKey, resolved.cacheKey);
    const query = new URLSearchParams({
      id,
      v: resolved.contentVersion,
      voice: resolved.voice,
      hash: resolved.contentHash,
    });
    assert.equal(audio.bundledExaminerAudioUrl(id), `/api/examiner-audio?${query}`);
    keys.add(resolved.cacheKey);
  }
  assert.equal(keys.size, audio.BUNDLED_EXAMINER_AUDIO_IDS.length);
});

test("the examiner-audio Worker is an allowlisted raw-MP3 cache with real seek ranges", () => {
  assert.ok(existsSync(examinerRoutePath), "missing app/api/examiner-audio/route.ts");
  const route = readFileSync(examinerRoutePath, "utf8");

  assert.match(route, /bundledExaminerAudio\(/);
  assert.match(route, /url\.searchParams\.get\("id"\)/);
  assert.match(route, /hasExactMediaTokens\(/);
  assert.doesNotMatch(route, /searchParams\.get\("(?:text|prompt|question)"\)/);
  assert.match(route, /BANDUP_FILES\.head\(/);
  assert.match(route, /BANDUP_FILES\.get\(/);
  assert.match(route, /BANDUP_FILES\.put\(/);
  assert.match(route, /AI\.run\(\s*EXAMINER_AUDIO_MODEL,/);
  assert.doesNotMatch(route, /AI\.run\(\s*["']@cf\//u);
  assert.match(route, /from "@\/lib\/examiner-audio"/);
  assert.match(route, /Content-Type["']?\s*[:,]\s*["']audio\/mpeg["']/);
  assert.match(route, /returnRawResponse:\s*true/);
  assert.doesNotMatch(route, /(?:await\s+)?(?:audio|speech|synthesis|generated)\.json\(/);
  assert.doesNotMatch(route, /JSON\.stringify\(\s*(?:audio|speech|synthesis|generated)/);
  assert.match(route, /request\.headers\.get\("Range"\)/);
  assert.match(route, /parseSingleRange\(/);
  assert.match(route, /BANDUP_FILES\.get\([^,]+,\s*range \? \{ range \} : undefined\)/);
  assert.match(route, /status:\s*206/);
  assert.match(route, /status:\s*416/);
  assert.match(route, /Content-Range/);
  assert.match(route, /Accept-Ranges/);
  const cacheHit = route.indexOf("if (cached)");
  const limiter = route.indexOf("AUDIO_GENERATION_RATE_LIMITER.limit");
  const generation = route.indexOf("AI.run(");
  assert.ok(cacheHit >= 0 && limiter > cacheHit, "cached examiner MP3s must bypass the limiter");
  assert.ok(generation > limiter, "examiner generation must be limited by its exact R2 cache key");
  assert.match(route, /limit\(\{ key: source\.cacheKey \}\)/);
  assert.match(route, /status:\s*429/);
  assert.match(route, /"Retry-After"/);
});

test("production and preview use separate rate-limit namespaces for audio generation and model relays", () => {
  const production = readJsonc(join(root, "wrangler.jsonc"));
  const preview = readJsonc(join(root, "wrangler.preview.jsonc"));
  const all = [...production.ratelimits, ...preview.ratelimits];
  assert.deepEqual(
    production.ratelimits.map((binding) => binding.name),
    ["AUDIO_GENERATION_RATE_LIMITER", "MODEL_FETCH_RATE_LIMITER"],
  );
  assert.deepEqual(
    preview.ratelimits.map((binding) => binding.name),
    ["AUDIO_GENERATION_RATE_LIMITER", "MODEL_FETCH_RATE_LIMITER"],
  );
  assert.equal(new Set(all.map((binding) => binding.namespace_id)).size, 4);
  assert.ok(all.every((binding) => binding.simple.period === 60 && binding.simple.limit > 0));
});

test("SpeakingSession plays fixed native examiner audio before browser speak recovery", () => {
  const session = readFileSync(speakingSessionPath, "utf8");
  const player = sourceFrom(session, "const playExaminerPrompt");

  assert.match(session, /examinerQuestionAudioId\(/);
  assert.match(session, /examinerFollowUpAudioId\(/);
  assert.match(session, /document\.createElement\("audio"\)/);
  assert.match(session, /setAttribute\("data-examiner-native-audio", "true"\)/);
  assert.match(player, /media\.src\s*=\s*apiUrl\(bundledExaminerAudioUrl\(audioId\)\)/);
  assert.match(player, /void media\.play\(\)\.catch\(fallbackToDeviceAudio\)/);
  assert.match(player, /speak\(/);
  assert.match(
    player,
    /const fallbackToDeviceAudio[\s\S]*?void speak\(fallbackText, rate\)/,
    "browser speak must be confined to native-media recovery",
  );
  assert.match(
    player,
    /if \(!audioId \|\| !media\)[\s\S]{0,360}?speak\(fallbackText, rate\)/,
    "browser speak may run directly only when no canonical native prompt exists",
  );

  const ask = sourceFrom(session, "const askCurrent").slice(0, 2_500);
  const repeat = sourceFrom(session, "const repeatQuestion").slice(0, 3_000);
  const next = sourceFrom(session, "const nextQuestion").slice(0, 4_000);
  assert.match(ask, /playExaminerPrompt\(/);
  assert.match(repeat, /playExaminerPrompt\(/);
  assert.match(next, /playExaminerPrompt\(/);
  assert.doesNotMatch(ask, /await speak\(/);
  assert.doesNotMatch(repeat, /await speak\(/);
  assert.doesNotMatch(next, /speak\(examinerFollowUp/);
});
