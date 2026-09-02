"use client";

/*
  Native bridges for iOS.

  Inside the iOS app the UI runs in a WKWebView, where the Web Speech API's
  *recognition* half does not exist at all — the speaking test would simply have
  no microphone. Speech synthesis is also unreliable there. So on a native
  platform we route both through Capacitor plugins that call Apple's own
  SFSpeechRecognizer and AVSpeechSynthesizer, and keep the Web Speech API for
  ordinary browsers.

  The imports are dynamic so the browser bundle never loads the plugin code.
*/

export function isNative(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return Boolean(cap?.isNativePlatform?.());
}

interface NativeTTS {
  speak(opts: { text: string; lang: string; rate: number; pitch: number }): Promise<void>;
  stop(): Promise<void>;
}

interface PartialResults {
  matches: string[];
}

interface NativeSTT {
  available(): Promise<{ available: boolean }>;
  requestPermissions(): Promise<{ speechRecognition: string }>;
  start(opts: {
    language: string;
    partialResults: boolean;
    popup: boolean;
  }): Promise<{ matches?: string[] } | void>;
  stop(): Promise<void>;
  addListener(
    event: "partialResults",
    cb: (data: PartialResults) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  removeAllListeners(): Promise<void>;
}

/*
  Why a plugin is never handed back as it arrives.

  What `registerPlugin` returns is a Proxy, and a Proxy has to answer for
  property names it has never heard of: it cannot know which of them are real
  methods of the native class, so it answers every one of them with a function
  that calls native. `then` is one of those names. That makes the plugin a
  thenable, and returning a thenable from an `async` function is not the same
  as returning an object — the language adopts it. It calls
  `then(resolve, reject)` to ask the value what it really is, Capacitor reads
  that as a call to a native method named `then`, finds none, and rejects the
  promise its wrapper returned. Nobody is listening to that promise, and the
  `resolve` and `reject` the runtime handed over are never called at all: the
  promise this function returns therefore never settles.

  So `await nativeSTT()` in lib/speech.ts waited for ever. On iOS the speaking
  test opened no microphone, reported no error, and sat there saying
  "Answering" over an empty answer box for as long as the candidate spoke —
  the whole feature, silently absent.

  Copying the methods this app actually calls onto an ordinary object is the
  fix, and it has to be a copy rather than anything cleverer: the object must
  have no `then` of its own, or the adoption happens all over again. Every
  method still goes straight to the same plugin.
*/
function plainPlugin<T extends object>(plugin: T, methods: readonly (keyof T)[]): T {
  const flattened: Record<string, unknown> = {};
  for (const name of methods) {
    const method = plugin[name];
    if (typeof method === "function") {
      flattened[String(name)] = (method as (...args: unknown[]) => unknown).bind(plugin);
    }
  }
  return flattened as T;
}

export async function nativeTTS(): Promise<NativeTTS | null> {
  if (!isNative()) return null;
  try {
    const mod = await import("@capacitor-community/text-to-speech");
    return plainPlugin(mod.TextToSpeech as unknown as NativeTTS, ["speak", "stop"]);
  } catch {
    return null;
  }
}

export async function nativeSTT(): Promise<NativeSTT | null> {
  if (!isNative()) return null;
  try {
    const mod = await import("@capacitor-community/speech-recognition");
    return plainPlugin(mod.SpeechRecognition as unknown as NativeSTT, [
      "available",
      "requestPermissions",
      "start",
      "stop",
      "addListener",
      "removeAllListeners",
    ]);
  } catch {
    return null;
  }
}

/*
  The on-device recogniser, which is a different thing from the one above:
  Apple's SFSpeechRecognizer may transcribe in iCloud, whereas this is
  whisper.cpp compiled into the app and running on the phone. The Swift side
  lives in ios-plugins/local-transcription: written and documented, never
  compiled, because that needs a Mac (see TRANSCRIPTION.md). It is deliberately
  not wired into package.json yet, so `cap sync` does not pick it up and
  `nativeWhisperAvailable()` answers false — on iOS the speaking test offers
  only Apple's recogniser until someone builds this on a Mac and sees it work.
*/
export interface NativeWhisperProgress {
  percent: number;
}

export interface NativeWhisper {
  isAvailable(): Promise<{ available: boolean; model?: string }>;
  requestPermissions(): Promise<{ microphone: string }>;
  /** Load the weights into memory ahead of the first answer. */
  prepare(opts: { model: string }): Promise<void>;
  start(opts: { model: string }): Promise<void>;
  stop(): Promise<{ text: string }>;
  cancel(): Promise<void>;
  addListener(
    event: "progress",
    cb: (data: NativeWhisperProgress) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

export async function nativeWhisper(): Promise<NativeWhisper | null> {
  if (!isNative()) return null;
  try {
    const { registerPlugin } = await import("@capacitor/core");
    // Flattened for the reason plainPlugin gives, and this one needs it most:
    // the plugin genuinely is not in the build, so every method is going to
    // reject, and `nativeWhisperAvailable()` below can only catch a rejection
    // it is actually given.
    return plainPlugin(registerPlugin<NativeWhisper>("LocalTranscription"), [
      "isAvailable",
      "requestPermissions",
      "prepare",
      "start",
      "stop",
      "cancel",
      "addListener",
    ]);
  } catch {
    return null;
  }
}

/**
 * Whether this build actually has the whisper plugin. `registerPlugin` hands
 * back a proxy whatever happens, so the only honest test is to call it.
 */
export async function nativeWhisperAvailable(): Promise<boolean> {
  const plugin = await nativeWhisper();
  if (!plugin) return false;
  try {
    const { available } = await plugin.isAvailable();
    return available;
  } catch {
    return false;
  }
}
