# @bandup/capacitor-local-transcription

whisper.cpp, running on the phone, behind the same interface the web path uses.
`lib/transcribe.ts` calls `prepare` / `start` / `stop` / `cancel` and listens for
`progress`; audio never crosses back into JavaScript, only text.

## This has never been compiled

Say it plainly, because a reader has no other way to know: **none of the Swift
in this directory has been built, run, or tested.** It was written on Linux, in
an environment with no Mac, no Xcode, no iOS SDK and no device — the same
constraint `APPSTORE.md` records for the rest of the iOS work. It is written to
be correct and it may still be wrong in ways only a compiler will tell you.

Nothing that ships to users depends on it yet. The plugin is **not** wired into
the app's `package.json`, so `npx cap sync ios` does not pick it up, and on iOS
the speaking test reports on-device transcription as unavailable and keeps using
Apple's recogniser. Wiring it in is a deliberate step, taken on a Mac, by
someone who can watch it build.

## Building it into the app

On a Mac with Xcode:

```bash
npm install ./ios-plugins/local-transcription
npm run ios:sync                 # build:mobile + npx cap sync ios
npm run ios:open
```

`cap sync` resolves the plugin through the `capacitor` block in its
`package.json`, and Swift Package Manager resolves whisper.cpp from
`Package.swift`. The first build downloads and compiles whisper.cpp, which takes
a while.

Then check, in this order:

1. It compiles, and `LocalTranscription` appears in Capacitor's plugin list at
   launch.
2. `Info.plist` has `NSMicrophoneUsageDescription`. Recording fails without it,
   and App Review rejects a build that asks for the microphone without saying
   why.
3. The speaking test offers "On this device only" — if it still says the app
   doesn't include the model, `isAvailable` is not reaching this plugin.
4. Answer a question and watch the progress events arrive while it transcribes.

## The model

`ModelStore` looks for `ggml-base.en.bin` (or `ggml-tiny.en.bin`) in the app
bundle first, then in Application Support, and downloads it from Hugging Face if
neither has it. Downloading keeps the App Store binary small; bundling the file
instead makes the first answer instant and the app 145 MB larger. Whichever you
choose, `/privacy` has to match it — it currently describes the download.

## Layout

| File | What it does |
| --- | --- |
| `LocalTranscriptionPlugin.swift` | The Capacitor bridge and the plugin's state machine. |
| `AudioRecorder.swift` | `AVAudioEngine` capture, converted to 16 kHz mono float. |
| `WhisperContext.swift` | The whisper.cpp context; the only file that talks to C. |
| `ModelStore.swift` | Finding, downloading and caching the ggml weights. |
