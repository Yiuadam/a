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
const turnControl = await import(
  pathToFileURL(join(root, "lib", "speaking", "turn-control.ts")).href,
);
const speakingTopics = JSON.parse(
  readFileSync(join(root, "data", "speaking-topics.json"), "utf8"),
);

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
    assert.equal(
      normaliseWords(resolved.parts.map((part) => part.text).join("\n")),
      normaliseWords(resolved.text),
      "per-turn recording must preserve every reviewed word without moving a boundary",
    );

    const canonicalSpeakers = [...new Set(paper.script.map((turn) => turn.speaker))];
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

    for (const [turnIndex, turn] of paper.script.entries()) {
      const turnParts = partsByTurn.get(turnIndex);
      assert.ok(turnParts?.length, `turn ${turnIndex + 1} needs a native MP3`);
      assert.equal(
        normaliseWords(turnParts.map((part) => part.text).join("\n")),
        normaliseWords(turn.text),
        "a turn's MP3 parts must reassemble to exactly that speaker's reviewed wording",
      );
      if (turn.text.trim().length <= audio.MAX_AURA_AUDIO_CHARS) {
        assert.equal(turnParts.length, 1, "an ordinary dialogue turn must remain one MP3");
      } else {
        assert.ok(turnParts.length > 1, "only an overlong monologue may be split for Aura");
      }

      const knownVoice = voiceBySpeaker.get(turn.speaker);
      const expectedVoice = knownVoice ?? (canonicalSpeakers.indexOf(turn.speaker) % 2 === 0 ? "athena" : "helios");
      voiceBySpeaker.set(turn.speaker, expectedVoice);

      for (const [turnPartIndex, part] of turnParts.entries()) {
        assert.equal(part.turnIndex, turnIndex, "split MP3s must keep their original dialogue boundary");
        assert.equal(part.speaker, turn.speaker, "the MP3 must retain the canonical speaker identity");
        assert.equal(part.voice, expectedVoice, "a canonical speaker must retain their voice across turns");
        assert.ok(part.text.length > 0, "an empty MP3 part would create a silent gap");
        assert.ok(part.text.length <= 1_800, "Aura input must stay below its 2,000-character limit");
        assert.match(
          part.voice,
          /^(?:athena|helios)$/,
          "reviewed listening dialogue must use one of Aura's documented British voices",
        );

        // Keep the content fingerprint, turn-part boundary, and voice identity
        // in R2. A corrected line or speaker assignment may never reuse an MP3
        // rendered from the old text or the other dialogue voice.
        assert.match(
          part.cacheKey,
          new RegExp(
            `^public/audio/listening/aura-1-v3/${paper.id}-turn-${turnIndex + 1}-part-${turnPartIndex + 1}-${part.voice}-[a-f0-9]{8,}\\.mp3$`,
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
  for (const badId of ["", "listening-12", "https://example.test/voice.mp3", "../../secret"]) {
    assert.equal(audio.bundledListeningAudio(badId), null);
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
  assert.match(route, /AI\.run\(\s*["']@cf\/deepgram\/aura-1["']/);
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
      new RegExp(`^public/audio/examiner/aura-1-v1/${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[a-f0-9]{8,}\\.mp3$`),
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
  assert.match(route, /AI\.run\(\s*["']@cf\/deepgram\/aura-1["']/);
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
