/*
  The pure parts of the on-device transcription path.

  Whisper does not only return words. It annotates what it hears that is not
  speech — `[BLANK_AUDIO]` over a pause, `(coughs)`, `♪` over anything musical —
  and those annotations would go straight into a transcript that is about to be
  marked for fluency and coherence. A candidate who paused to think would be
  marked on the pause. Stripping them is therefore load-bearing, and so is the
  limit on it: an aside the candidate actually typed in brackets is theirs and
  must survive.

  The saved-preference parser matters for a smaller reason: it reads whatever is
  in localStorage, which is to say anything at all, and a learner must never
  arrive at the speaking test to find it broken by a bad value.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const load = (file) => import(pathToFileURL(join(process.cwd(), "lib", file)).href);

const {
  cleanTranscript,
  mergeAnswer,
  formatBytes,
  describeStatus,
  fetchModelWithProgress,
  isWhisperGgmlHeader,
  LOCAL_MODELS,
  modelDownloadUrls,
} = await load("transcribe.ts");
const { parseSpeechPrefs, DEFAULT_SPEECH_PREFS } = await load("speech.ts");

test("whisper's non-speech annotations are stripped", () => {
  assert.equal(cleanTranscript(["[BLANK_AUDIO]"]), "");
  assert.equal(
    cleanTranscript([" I think", " [BLANK_AUDIO]", " so, yes. (coughs)"]),
    "I think so, yes.",
  );
  assert.equal(cleanTranscript(["♪ La la ♪ I live in Hanoi."]), "La la I live in Hanoi.");
  assert.equal(cleanTranscript(["*laughs* Not really."]), "Not really.");
});

test("a candidate's own parenthetical survives", () => {
  assert.equal(
    cleanTranscript(["My city (Da Nang) is on the coast."]),
    "My city (Da Nang) is on the coast.",
  );
});

test("segments are joined without stray gaps before punctuation", () => {
  assert.equal(cleanTranscript(["Well", " , I suppose  so ."]), "Well, I suppose so.");
});

test("nothing said transcribes to nothing, not to whitespace", () => {
  assert.equal(cleanTranscript([]), "");
  assert.equal(cleanTranscript(["   ", "[BLANK_AUDIO]", "  "]), "");
});

test("a transcription is appended to whatever the candidate already typed", () => {
  assert.equal(mergeAnswer("I live in Lima.", "It is very big."), "I live in Lima. It is very big.");
  assert.equal(mergeAnswer("", "It is very big."), "It is very big.");
  assert.equal(mergeAnswer("I live in Lima.", "   "), "I live in Lima.");
  assert.equal(mergeAnswer("  ", "  "), "");
});

test("download sizes are stated the way a person reads them", () => {
  assert.equal(formatBytes(148_000_000), "148 MB");
  assert.equal(formatBytes(78_000_000), "78 MB");
});

test("the model byte contracts match the canonical Whisper files", () => {
  /*
    `fetchModelWithProgress` deliberately rejects a file whose final byte
    count differs from the model contract. These are the current
    Content-Length values served by ggerganov/whisper.cpp, not rounded display
    sizes. Rounding them to 78/148 million makes every successful download
    look truncated at its final byte.
  */
  assert.equal(LOCAL_MODELS["tiny.en"].bytes, 77_704_715);
  assert.equal(LOCAL_MODELS["base.en"].bytes, 147_964_211);
});

test("the canonical Whisper GGML header is accepted in its on-disk byte order", () => {
  // The public ggml-tiny.en.bin starts `6c 6d 67 67` (`lmgg`): the
  // little-endian byte representation of the GGML magic 0x67676d6c.
  assert.equal(isWhisperGgmlHeader(Uint8Array.from([0x6c, 0x6d, 0x67, 0x67])), true);
  assert.equal(isWhisperGgmlHeader(Uint8Array.from([0x67, 0x67, 0x6d, 0x6c])), false);
  assert.equal(isWhisperGgmlHeader(Uint8Array.from([0x3c, 0x68, 0x74, 0x6d])), false);
});

test("direct model delivery is preferred, with one bounded same-origin fallback", () => {
  const urls = modelDownloadUrls("tiny.en");
  assert.match(urls[0], /huggingface\.co\/ggerganov\/whisper\.cpp/);
  assert.match(urls[0], /ggml-tiny\.en\.bin$/);
  assert.equal(urls.at(-1), "/api/speech-model?model=ggml-tiny.en.bin");
  assert.equal(urls.filter((url) => url.startsWith("/api/speech-model?")).length, 1);
});

test("every phase says something a learner can understand", () => {
  assert.equal(describeStatus({ phase: "recording", percent: null }), "Recording");
  assert.equal(
    describeStatus({ phase: "downloading", percent: 42.4 }),
    "Downloading the speech model 42%",
  );
  assert.equal(describeStatus({ phase: "loading", percent: null }), "Starting the speech model");
  assert.equal(
    describeStatus({ phase: "transcribing", percent: 7 }),
    "Transcribing on your device 7%",
  );
});

test("a saved preference is honoured", () => {
  assert.deepEqual(parseSpeechPrefs('{"engine":"local","model":"tiny.en"}'), {
    engine: "local",
    model: "tiny.en",
  });
});

test("nonsense in storage falls back to the platform recogniser", () => {
  for (const raw of [null, "", "not json", "[]", '{"engine":"telepathy","model":"huge"}']) {
    assert.deepEqual(parseSpeechPrefs(raw), DEFAULT_SPEECH_PREFS, `for ${JSON.stringify(raw)}`);
  }
});

test("the default is the platform recogniser, and the accurate local model", () => {
  assert.equal(DEFAULT_SPEECH_PREFS.engine, "platform");
  assert.equal(DEFAULT_SPEECH_PREFS.model, "base.en");
});

test("an interrupted model download retries from the first missing byte", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const checkpoints = [];
  const statuses = [];
  let call = 0;

  globalThis.fetch = async (_url, init = {}) => {
    requests.push(new Headers(init.headers).get("Range"));
    call += 1;
    if (call === 1) {
      let read = false;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "Content-Length": "8" }),
        body: {
          getReader() {
            return {
              async read() {
                if (!read) {
                  read = true;
                  return { done: false, value: Uint8Array.from([0x67, 0x67, 0x6d, 0x6c]) };
                }
                throw new Error("connection dropped");
              },
            };
          },
        },
      };
    }
    return new Response(Uint8Array.from([4, 5, 6, 7]), {
      status: 206,
      headers: { "Content-Range": "bytes 4-7/8" },
    });
  };

  try {
    const blob = await fetchModelWithProgress(
      "https://models.example/model.bin",
      8,
      (status) => statuses.push(status),
      null,
      async (partial) => checkpoints.push(partial.size),
    );
    assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0x67, 0x67, 0x6d, 0x6c, 4, 5, 6, 7]);
    assert.deepEqual(requests, [null, "bytes=4-7"]);
    assert.deepEqual(checkpoints, [4]);
    assert.deepEqual(statuses.at(-1), { phase: "downloading", percent: 100 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a saved model prefix resumes on a later retry", async () => {
  const originalFetch = globalThis.fetch;
  let requestedRange = null;
  globalThis.fetch = async (_url, init = {}) => {
    requestedRange = new Headers(init.headers).get("Range");
    return new Response(Uint8Array.from([8, 9, 10, 11]), {
      status: 206,
      headers: { "Content-Range": "bytes 4-7/8" },
    });
  };

  try {
    const prefix = new Blob([Uint8Array.from([0x67, 0x67, 0x6d, 0x6c])]);
    const blob = await fetchModelWithProgress(
      "https://models.example/model.bin",
      8,
      () => {},
      prefix,
    );
    assert.equal(requestedRange, "bytes=4-7");
    assert.equal(blob.size, 8);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
