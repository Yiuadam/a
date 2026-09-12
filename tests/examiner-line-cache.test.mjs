/*
  Stretching the Workers AI Free-plan Neuron ceiling for the one examiner
  clip that used to regenerate on every single request.

  app/api/speaking/examiner-line/route.ts writes a fresh sentence per answer,
  but the system prompt (see that route) leaves the model almost no room to
  vary a transition — one short, neutral line, never a question, never
  praise — so the same handful of sentences comes back for many different
  candidates. lib/examiner-audio.ts's synthesizeExaminerLineAudio now banks
  each one in R2 keyed on the model, the voice and the normalised words, the
  same way the fixed examiner/listening catalogues already bank their own
  prompts, so a repeat is an R2 read rather than a Neuron-metered Aura call.

  This file proves the cache itself with a fake `ai.run` and a fake R2 (no
  network, no Cloudflare bindings, no cost), then proves — at the source
  level, the way every other test of this route and this client already
  does — that a candidate who draws the cheap failure status this route now
  answers with still hears something: the fixed scripted bridge, and beyond
  that the device voice, never silence and never a broken turn.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const {
  examinerLineAudioSource,
  synthesizeExaminerLineAudio,
  EXAMINER_AUDIO_MODEL,
  BUNDLED_EXAMINER_AUDIO_VOICE,
} = await import(pathToFileURL(join(root, "lib", "examiner-audio.ts")).href);

const route = read("app", "api", "speaking", "examiner-line", "route.ts");
const session = read("components", "speaking", "SpeakingSession.tsx");

/* A stand-in for R2Bucket that only implements what synthesizeExaminerLineAudio
   actually calls — `get` and `put` — so a miss, a hit and a write are all
   directly observable rather than inferred from Aura call counts alone. */
function fakeR2() {
  const store = new Map();
  const puts = [];
  return {
    async get(key) {
      const value = store.get(key);
      return value ? { arrayBuffer: async () => value } : null;
    },
    async put(key, value) {
      store.set(key, value);
      puts.push(key);
    },
    store,
    puts,
  };
}

/* A stand-in for the `ai` binding. `throwsWith` reproduces the one failure
   mode this task is about: Workers AI on the Free plan throws once the daily
   Neuron ceiling is spent, it does not return a slow or degraded response. */
function fakeAi(bytes, { throwsWith } = {}) {
  const calls = [];
  return {
    calls,
    async run(model, input, config) {
      calls.push({ model, input, config });
      if (throwsWith) throw new Error(throwsWith);
      return new Response(bytes.slice(), { status: 200 });
    },
  };
}

// Comfortably over the route's own `< 8 bytes` floor for implausible audio.
const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02]);

test("the cache key is built from the model, the voice and the normalised words, not a caller-suppliable id", () => {
  const source = examinerLineAudioSource("Let's move on to the next question.");
  assert.ok(source);
  assert.equal(source.voice, BUNDLED_EXAMINER_AUDIO_VOICE);
  assert.match(source.contentHash, /^[a-f0-9]{8}$/u);
  assert.match(
    source.cacheKey,
    new RegExp(`^public/audio/examiner-line/[^/]+/${BUNDLED_EXAMINER_AUDIO_VOICE}-[a-f0-9]{8}\\.mp3$`),
  );

  // Incidental whitespace from the model's own sampling must not miss a hit
  // that would otherwise exist.
  const padded = examinerLineAudioSource("  Let's   move on to the next question.  ");
  assert.equal(padded.cacheKey, source.cacheKey, "whitespace-only differences must still hit the same key");

  // A materially different sentence must not collide with it.
  const different = examinerLineAudioSource("Right, let's talk about something else instead.");
  assert.notEqual(different.cacheKey, source.cacheKey);

  // Nothing to speak resolves to nothing to cache, rather than an empty MP3.
  assert.equal(examinerLineAudioSource(""), null);
  assert.equal(examinerLineAudioSource("   "), null);
});

test("two requests for the same normalised line call ai.run once and serve the second from R2", async () => {
  const files = fakeR2();
  const ai = fakeAi(MP3_BYTES);

  const first = await synthesizeExaminerLineAudio({ files, ai }, "Let's move on to the next question.");
  assert.equal(first.ok, true);
  assert.equal(first.cached, false);
  assert.equal(ai.calls.length, 1);
  assert.equal(files.puts.length, 1);
  assert.equal(ai.calls[0].model, EXAMINER_AUDIO_MODEL);
  assert.equal(ai.calls[0].input.speaker, BUNDLED_EXAMINER_AUDIO_VOICE);

  // A second candidate, told the same thing by the model in a different
  // session, with only whitespace differing.
  const second = await synthesizeExaminerLineAudio({ files, ai }, "  Let's   move on to the next question. ");
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
  assert.equal(ai.calls.length, 1, "a repeated line must not call Workers AI a second time");
  assert.equal(files.puts.length, 1, "a cache hit must not write to R2 again");
  assert.deepEqual(new Uint8Array(second.audio), new Uint8Array(first.audio));
});

test("a different line is a different key, and is generated again", async () => {
  const files = fakeR2();
  const ai = fakeAi(MP3_BYTES);

  await synthesizeExaminerLineAudio({ files, ai }, "Let's move on to the next question.");
  await synthesizeExaminerLineAudio({ files, ai }, "Right, let's talk about something else instead.");

  assert.equal(ai.calls.length, 2);
  assert.equal(files.puts.length, 2);
  assert.notEqual(files.puts[0], files.puts[1]);
});

test("an ai.run that throws yields the cheap quota outcome and never writes to R2", async () => {
  const files = fakeR2();
  const ai = fakeAi(MP3_BYTES, { throwsWith: "10041: capacity temporarily exceeded" });

  const outcome = await synthesizeExaminerLineAudio({ files, ai }, "Let's move on to the next question.");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "quota");
  assert.match(outcome.reason, /capacity temporarily exceeded/);
  assert.equal(files.puts.length, 0, "a failed generation must leave R2 untouched");

  // A retry after the outage clears must still be able to generate and cache
  // normally — the failure must not have left anything behind that blocks it.
  const recoveredAi = fakeAi(MP3_BYTES);
  const recovered = await synthesizeExaminerLineAudio({ files, ai: recoveredAi }, "Let's move on to the next question.");
  assert.equal(recovered.ok, true);
  assert.equal(recovered.cached, false);
  assert.equal(files.puts.length, 1);
});

test("the route turns that outcome into a 503 with a small JSON body and one structured log line, never a bare 500", () => {
  const handler = route.slice(route.indexOf("async function handlePOST"));
  assert.match(handler, /const outcome = await synthesizeExaminerLineAudio\(/);
  assert.match(handler, /if \(outcome\.kind === "quota"\)/);
  assert.match(handler, /return safeJsonError\(MESSAGES\.unavailable, 503\);/);
  // The other, non-quota failure kind still answers with the route's own
  // ordinary generic-unavailable response rather than a body-carrying one.
  assert.match(handler, /return unavailable\(502\);/);

  const logCall = handler.slice(handler.indexOf("console.error(JSON.stringify({"));
  const logBlock = logCall.slice(0, logCall.indexOf("}));"));
  assert.match(logBlock, /message: "examiner tts unavailable"/);
  assert.match(logBlock, /route: "speaking\/examiner-line"/);
  assert.match(logBlock, /reason: outcome\.reason/);
  // No candidate text and no model-written line anywhere in the log call —
  // only the provider's own error message travels. (Excludes "examiner-line",
  // the route name, which is expected and is not the candidate's words.)
  assert.doesNotMatch(logBlock, /(?<![\w-])line(?![\w-])/);
  assert.doesNotMatch(logBlock, /\banswer\b/);
});

test("a non-2xx from examiner-line still ends in the candidate's device voice, with no console noise and no broken turn", () => {
  /*
    The client never branches on which non-2xx it got (429 today, this task's
    new 503, or anything else) — it treats every failed fetch identically,
    which is what makes the new status "cheap": nothing downstream has to
    learn about it.
  */
  const fire = session.slice(session.indexOf("const fireExaminerLine = useCallback"));
  const body = fire.slice(0, fire.indexOf("[]"));
  assert.match(
    body,
    /if \(!res\.ok\) \{\s*\n\s*examinerLineStatusRef\.current = "unavailable";\s*\n\s*return;\s*\n\s*\}/,
  );
  assert.match(
    body,
    /\.catch\(\(\) => \{\s*\n\s*if \(stillWanted\(\)\) examinerLineStatusRef\.current = "unavailable";\s*\n\s*\}\);/,
  );
  assert.doesNotMatch(body, /console\.(error|warn|log)/, "a failed examiner-line fetch must stay silent");

  // "unavailable" (unlike "ready") withholds the live bridge...
  const nextQ = session.slice(
    session.indexOf("const nextQuestion = useCallback"),
    session.indexOf("const readMicrophoneLevel"),
  );
  assert.match(nextQ, /examinerLineStatusRef\.current === "ready"/);

  // ...so the turn falls straight through to the same scripted-bridge call a
  // bridge that failed to *play* also falls back to — the interview is never
  // left waiting on the request that just failed.
  assert.match(
    nextQ,
    /: playExaminerPrompt\(\s*\n\s*examinerFollowUpAudioId\(steps, stepIndex, reason\),\s*\n\s*examinerFollowUp\(steps, stepIndex, reason\),/,
  );

  // And playExaminerPrompt's own recovery — the only place in this file that
  // reaches for the device voice — is what plays if even that scripted MP3
  // cannot be reached.
  const player = session.slice(
    session.indexOf("const playExaminerPrompt = useCallback"),
    session.indexOf("const askCurrent = useCallback"),
  );
  assert.match(player, /const onError = \(\) => fallbackToDeviceAudio\(\);/);
  assert.match(player, /void speak\(fallbackText, rate\)/);
  assert.doesNotMatch(player, /console\.(error|warn|log)/, "the device-voice recovery path must stay silent too");
});
