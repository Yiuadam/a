# On-device transcription

The speaking test can now transcribe without sending audio anywhere. This
document says what was built, what it costs, **what was not measured**, and why
the private option is not the default.

Issue: [#32](https://github.com/Yiuadam/a/issues/32).

## What was built

| | Web | iOS |
| --- | --- | --- |
| Engine | whisper.cpp compiled to WebAssembly ([`@transcribe/shout`](https://www.npmjs.com/package/@transcribe/shout), driven by `@transcribe/transcriber`) | whisper.cpp built natively, via the Capacitor plugin in `ios-plugins/local-transcription` |
| Weights | ggml `base.en` or `tiny.en`, fetched once from Hugging Face, cached in the Cache API | the same ggml files, cached in Application Support |
| Status | **working, exercised in a browser** | **written, never compiled** |

Both sit behind one interface in `lib/transcribe.ts`, so `app/speaking/page.tsx`
does not know which platform it is on. The engine choice lives in
`lib/speech.ts` under `bandup.speech.v1` and defaults to `platform`.

The typed-answer fallback is untouched and always available. Someone who
refuses both recognisers can still sit the whole test.

### Why the web path needs cross-origin isolation

whisper.cpp's WASM build uses pthreads, pthreads need `SharedArrayBuffer`, and
browsers only grant that to a cross-origin-isolated document. `next.config.ts`
therefore sends `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` **on `/speaking` only** — isolation
constrains every cross-origin subresource a page loads, and no other page needs
it. The model download still works because it is a CORS request, which satisfies
`require-corp`.

A static export has no server and cannot send headers, which is why the iOS
bundle is never isolated, and why iOS needs the native plugin rather than the
WASM one. `npm run build:mobile` is unaffected.

### Why it transcribes after you finish, not as you speak

Whisper works on a window of audio, not a stream of it. A platform recogniser
writes words as they are said; this records the answer and transcribes it on
stop. That is a real change to how the test feels, so the wait is shown rather
than hidden: a progress bar reports the model download (once) and then the
transcription percentage, with the reminder that it is happening on the device.

## The accuracy question — unmeasured, and why

**No accuracy comparison was run. Nothing in this section is a measurement taken
here, and no number below should be quoted as one.**

What made it impossible in this environment:

- **The weights cannot be downloaded.** `huggingface.co` is blocked by the
  network egress policy (403 to `CONNECT`). So are `cdn.jsdelivr.net`, `unpkg`
  and the Hugging Face CDN hosts. No npm package ships ggml whisper weights.
  Without weights, neither `base.en` nor `tiny.en` can transcribe a single
  second of audio here — not in Node, not in a headless browser.
- **There is no microphone and no accented-speech corpus.** The container has
  neither audio input nor any licensed set of L2-English recordings with
  reference transcripts.
- **The platform recogniser cannot be run at all.** Chrome's Web Speech API
  transcribes by uploading to Google's service, which is exactly the thing that
  is unreachable — and Apple's recogniser needs a device. A head-to-head against
  it is not merely inconvenient here, it is structurally impossible.
- **Published figures could not be fetched either.** `arxiv.org` is blocked, as
  is Hugging Face, so the Whisper paper and the model cards could not be read to
  quote them accurately.

What is known well enough to reason from, all of it from published work rather
than from this repo, and all of it worth verifying before it is relied on:

- Whisper's reported WER improves monotonically with model size, and the
  `tiny` → `base` step is one of the larger relative jumps in the series. The
  commonly cited English-only numbers are in the region of ~5–6% WER for
  `tiny.en` and ~4–5% for `base.en` on LibriSpeech `test-clean`. **Treat those
  digits as recalled, not sourced.**
- LibriSpeech `test-clean` is read speech by mostly native speakers. It is the
  benchmark that exists; it is not the benchmark that matters here. Reported WER
  on accented and second-language English is substantially higher for every
  model size, and the gap between sizes tends to widen as the speech gets
  further from the training distribution — which is the argument for `base.en`
  over `tiny.en`, not an argument that either is good enough.
- The users of this app are non-native speakers by definition. A recogniser that
  drops or mangles words they said correctly makes the marking wrong, and the
  learner cannot tell which happened. That is a worse harm than the privacy leak
  this feature fixes.

**Recommendation: keep `platform` as the default.** Promote the local engine
only on evidence, not on principle. The feature ships as a choice the learner
can make with the trade stated plainly, which is honest today; making it the
default would be a claim about accuracy that nobody has yet earned.

`base.en` is the default *model within* the local option for the same reason:
when a mis-transcription costs marks, the accurate model beats the small one.

### How to run the comparison

On a machine with a microphone, and ideally with several speakers whose first
language is not English:

1. `npm run build && npx next start`, open `/speaking`, and pick a passage of
   80–150 words to read aloud. Keep the reference text — WER needs it.
2. Sit the same passage twice: once with "Your device's recogniser" selected in
   Chrome, once with "On this device only" and `base.en`. Then a third time with
   `tiny.en`.
3. Copy each transcript out of the answer box. Compute WER against the reference
   (`pip install jiwer`, then `jiwer reference.txt hypothesis.txt`), after
   lowercasing and stripping punctuation from both sides — Whisper punctuates
   and Web Speech largely does not, and counting that as error measures nothing.
4. Repeat for at least five speakers with different first languages. One
   speaker's result is an anecdote.

A decision rule worth agreeing before the numbers arrive, so they cannot be read
selectively: **promote the local engine to default only if `base.en` matches or
beats the platform recogniser on every speaker tested, or loses by so little
that no band would move.** If it loses on even one speaker by a margin that
could change a mark, it stays an option.

## Costs

| | `tiny.en` | `base.en` |
| --- | --- | --- |
| Download | ~75 MB, once, then cached | ~145 MB, once, then cached |
| In-app weight | none — nothing is bundled | none |
| Accuracy | weaker, and weakest where it matters | the default for the local engine |

Fixed costs regardless of model: `public/whisper/shout.wasm.js` is 1.5 MB (the
Emscripten build with the wasm inlined), loaded only when the local engine is
actually used. `@transcribe/transcriber` is 120 kB of plain JavaScript.

**Speed was not measured** — same reason as accuracy. Structurally: this is
CPU-only WASM with threads, so expect `tiny.en` to be near real time on a
laptop, `base.en` several times slower than that, and both markedly slower on a
phone. Whether the wait after a two-minute Part 2 answer is tolerable is a
question for the same session that measures accuracy, on real hardware.

Transformers.js (`@huggingface/transformers`) was considered and rejected: it
depends on `onnxruntime-node`, which takes `node_modules` to 689 MB — measured —
for a feature that only ever runs in a browser. The chosen packages also mean
web and iOS run the same engine on the same weights, so an accuracy measurement
on one says something about the other.

## What is verified, and what is not

Verified here — in a real Chromium at a 375 px viewport, against a production
build served by `next start`:

- `npx eslint .`, `npm run build`, `npm test` (26), `node scripts/validate-content.mjs`,
  `node scripts/simulate-placement.mjs` and `NEXT_PUBLIC_API_BASE=… npm run build:mobile`
  all pass.
- `/speaking` is genuinely cross-origin isolated: `crossOriginIsolated` is true,
  `SharedArrayBuffer` exists, wasm SIMD validates, `MediaRecorder` exists.
- **The whisper.cpp wasm engine itself starts.** The vendored
  `/whisper/shout.wasm.js` instantiates in ~100 ms and exposes `init`,
  `transcribe`, `cancel`, `free` and `FS_createDataFile`. It reserves a 537 MB
  heap, which is worth knowing before anyone tries this on an older phone. So
  the engine runs; only the weights are missing.
- The engine toggle, both model choices, and no horizontal overflow at 375 px
  (`scrollWidth` 375 = `clientWidth`).
- Recording starts and stops against a fake microphone, and the typed fallback
  fills the answer box and advances the interview.
- The two failure paths, both ending in a sentence a learner can act on rather
  than a stuck spinner: the model host being unreachable (which is simply true
  in this environment), and a host that returns something that is not a model —
  stubbed to check it, and the reason `looksLikeGgml` exists at all.
- The progress panel appears immediately on a stalled download and tracks real
  percentages, checked against a stubbed slow host with a `Content-Length`.

Not verified, and not claimed to be:

- **Any transcription at all.** No whisper model could be downloaded here, so no
  audio has ever been transcribed by this code — neither on the web path nor on
  iOS. The web path is verified up to the point where the weights arrive.
- **The entire iOS plugin.** Never compiled, never run. See
  `ios-plugins/local-transcription/README.md`.
- Accuracy and speed, per the sections above.
