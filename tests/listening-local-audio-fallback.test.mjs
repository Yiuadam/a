import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const root = process.cwd();
const listeningPage = readFileSync(join(root, "app", "practice", "listening", "page.tsx"), "utf8");
const neuralSpeech = readFileSync(join(root, "lib", "neural-speech.ts"), "utf8");
const speech = readFileSync(join(root, "lib", "speech.ts"), "utf8");
const notice = readFileSync(join(root, "public", "vendor", "kokoro", "NOTICE.txt"), "utf8");
const { LISTENING_TESTS } = await import(pathToFileURL(join(root, "lib", "tests.ts")).href);

function sourceFrom(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${marker}`);
  return source.slice(start);
}

test("every canonical listening paper is eligible for the local-audio recovery", () => {
  // Derived from the registry (`const bundled = LISTENING_TESTS`), so a new
  // paper is eligible the moment it is registered. The count is asserted as a
  // floor rather than a fixed number so authoring a paper cannot fail this.
  assert.ok(LISTENING_TESTS.length >= 11);
  assert.match(listeningPage, /const isBundledTest = !!test && bundled\.some\(/);
  assert.match(
    listeningPage,
    /const builtInAudioSupported = mounted && isBundledTest && naturalExaminerVoiceSupported\(\)/,
  );

  const fallback = sourceFrom(listeningPage, "const startBuiltInAudio");
  assert.match(fallback, /if \(!test \|\| !isBundledTest \|\| !builtInAudioSupported\)/);
  assert.match(fallback, /test\.script\.map\(\(turn\) => turn\.text\)\.join\("\\n"\)/);
  assert.match(fallback, /speakNaturalExaminer\(/);

  // An AI-generated paper must not silently trigger the larger local model.
  assert.match(
    listeningPage,
    /Generated papers continue to use browser speech[\s\S]*?never starts a large model download/,
  );
});

test("listening uses native BandUp media first and keeps the local voice as recovery", () => {
  const openTest = sourceFrom(listeningPage, "const openTest");
  assert.doesNotMatch(
    openTest,
    /prepareNaturalExaminerVoice\(/,
    "opening a working native recording must not trigger an unnecessary on-device model download",
  );

  const startAudio = sourceFrom(listeningPage, "const startAudio");
  assert.match(startAudio, /if \(isBundledTest\) \{[\s\S]*?startNativeAudio\(run, from\)/);
  const nativeAudio = sourceFrom(listeningPage, "const playNativeAudioPart");
  assert.match(nativeAudio, /media\.src = apiUrl\(bundledListeningAudioUrl\(test\.id, part\)\)/);
  assert.match(nativeAudio, /media\.play\(\)\.catch\(\(\) => fallbackFromNativeAudio\(run, from\)\)/);
  const browserAudio = sourceFrom(listeningPage, "const startBrowserAudio");
  assert.match(
    browserAudio,
    /if \(!ttsSupported\) \{[\s\S]*?void startBuiltInAudio\(run\)/,
  );
  assert.match(
    browserAudio,
    /onError: \(message\) => \{[\s\S]*?if \(builtInAudioSupported\) \{[\s\S]*?void startBuiltInAudio\(run\)/,
  );
  assert.match(listeningPage, /<audio[\s\S]*?data-listening-native-audio/);
  assert.match(listeningPage, /\{audioSupported && !playing \? \(/);
  assert.match(listeningPage, /cancelNaturalExaminerVoice\(\)/);
  assert.match(listeningPage, /disposeNaturalExaminerVoice\(\)/);
});

test("the shared fallback wait is bounded and does not poison an in-flight model download", () => {
  const wait = sourceFrom(neuralSpeech, "export async function waitForNaturalExaminerVoice");
  assert.match(neuralSpeech, /const RECOVERY_WAIT_TIMEOUT_MS = LOAD_TIMEOUT_MS/);
  assert.match(wait, /const preparation = prepareNaturalExaminerVoice\(\)/);
  assert.match(wait, /Promise\.race\(/);
  assert.match(wait, /Math\.min\(timeoutMs, RECOVERY_WAIT_TIMEOUT_MS\)/);
  assert.doesNotMatch(wait.slice(0, wait.indexOf("async function play")), /unavailable\s*=\s*true/);
  assert.match(neuralSpeech, /export function naturalExaminerVoiceBusy\(\)/);
});

test("speaking retries the local voice once only after a completely silent browser prompt", () => {
  const speak = sourceFrom(speech, "export async function speak");
  assert.match(speak, /browserResult === "interrupted"\) return false/);
  assert.match(speak, /browserResult === "completed"\) return true/);
  assert.match(speak, /await waitForNaturalExaminerVoice\(\)/);
  assert.equal(
    (speak.match(/waitForNaturalExaminerVoice\(/g) ?? []).length,
    1,
    "a failed browser voice must not loop forever through the local fallback",
  );
  assert.match(
    speech,
    /return i === 0 \? "not-started" : "interrupted"/,
    "only the first, entirely unheard line may be replayed locally",
  );
});

test("the fallback uses the already-vendored Apache-2.0 browser engine", () => {
  assert.ok(existsSync(join(root, "public", "vendor", "kokoro", "kokoro.web.js")));
  assert.ok(existsSync(join(root, "public", "vendor", "kokoro", "bf_emma.bin")));
  assert.match(notice, /Apache License 2\.0/);
});
