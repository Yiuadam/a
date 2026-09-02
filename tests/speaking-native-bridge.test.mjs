import assert from "node:assert/strict";
import { join } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("../scripts/ts-resolve.mjs", import.meta.url);

/*
  The microphone, tested at the one seam that silently lost it.

  lib/native.ts hands the rest of the app a Capacitor plugin, and a Capacitor
  plugin is a Proxy: it answers every property name with a function that calls
  native, because it cannot know which names are real methods. `then` is one of
  those names, which makes the plugin a thenable — and an `async` function that
  returns a thenable does not return it, it adopts it, calling
  `then(resolve, reject)` to ask what the value really is. Capacitor reads that
  as a call to a native method named `then`, finds none, and rejects its own
  promise without ever calling the resolve it was handed. The promise the
  bridge returned then never settles, `await nativeSTT()` waits for ever, and
  the iOS speaking test opens no microphone and reports no error.

  Nothing above this seam can notice that: the failure is a promise that stays
  pending, which looks exactly like a candidate who has not spoken yet. So the
  test is here, and it is a real one — the actual bridge, the actual plugin
  package, and a fake native shell standing in for the app.
*/
function pretendToBeTheApp() {
  const calls = [];
  globalThis.window = globalThis;
  /*
    `@capacitor/core` decides for itself which platform it is on, and it
    decides by looking for the WKWebView message handler the native bridge
    installs. Declaring a platform on the Capacitor object instead would be
    overwritten the moment the package loads, so the shell is built the way
    the real one is: the handler first, and everything else hung off it.
  */
  globalThis.webkit = { messageHandlers: { bridge: { postMessage: () => {} } } };
  globalThis.Capacitor = {
    // Answers until `@capacitor/core` loads and replaces it with its own,
    // which reaches the same answer by way of the handler above.
    isNativePlatform: () => true,
    Plugins: {},
    PluginHeaders: [
      {
        name: "SpeechRecognition",
        methods: [
          { name: "requestPermissions", rtype: "promise" },
          { name: "start", rtype: "promise" },
        ],
      },
      { name: "TextToSpeech", methods: [{ name: "speak", rtype: "promise" }] },
    ],
    nativePromise: async (plugin, method) => {
      calls.push(`${plugin}.${method}`);
      return {};
    },
    addListener: () => ({ remove: async () => {} }),
  };
  return calls;
}

/*
  Turns "never answered" into a value. The defect being guarded against is a
  promise that stays pending for ever, and a test that simply awaited it would
  hang the whole run rather than report anything, so the wait is bounded and
  the timeout becomes an ordinary assertion failure with a sentence attached.
*/
function within(milliseconds, promise) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve("never settled"), milliseconds)),
  ]);
}

const calls = pretendToBeTheApp();
const native = await import(
  pathToFileURL(join(process.cwd(), "lib", "native.ts")).href
);

test("asking for the recogniser answers, rather than waiting for ever", async () => {
  const stt = await within(2_000, native.nativeSTT());
  assert.notEqual(stt, "never settled", "nativeSTT() never settled: the microphone is unreachable");
  assert.ok(stt, "nativeSTT() gave nothing back on a native platform");
  assert.equal(
    typeof stt.then,
    "undefined",
    "the recogniser is thenable, so awaiting it will hang the speaking test",
  );
});

test("the recogniser handed back still reaches the native plugin", async () => {
  const stt = await within(2_000, native.nativeSTT());
  assert.notEqual(stt, "never settled");
  await stt.requestPermissions();
  await stt.start({ language: "en-GB", partialResults: true, popup: false });
  assert.ok(
    calls.includes("SpeechRecognition.requestPermissions"),
    "permission was never asked of the native plugin",
  );
  assert.ok(calls.includes("SpeechRecognition.start"), "the microphone was never opened");
});

test("the examiner's own voice answers on the same terms", async () => {
  const tts = await within(2_000, native.nativeTTS());
  assert.notEqual(tts, "never settled", "nativeTTS() never settled: the examiner would be mute");
  assert.equal(typeof tts.then, "undefined");
  await tts.speak({ text: "Where do you live?", lang: "en-GB", rate: 1, pitch: 1 });
  assert.ok(calls.includes("TextToSpeech.speak"), "the examiner's line never reached the plugin");
});

test("a plugin that is not in the build fails loudly instead of hanging", async () => {
  /* LocalTranscription is deliberately not compiled in — see lib/native.ts —
     so every call rejects. That is fine and expected; what must not happen is
     the lookup itself never answering, because nativeWhisperAvailable() can
     only catch a rejection it is actually given. */
  const available = await within(2_000, native.nativeWhisperAvailable());
  assert.equal(available, false);
});
