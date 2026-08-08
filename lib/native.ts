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

export async function nativeTTS(): Promise<NativeTTS | null> {
  if (!isNative()) return null;
  try {
    const mod = await import("@capacitor-community/text-to-speech");
    return mod.TextToSpeech as unknown as NativeTTS;
  } catch {
    return null;
  }
}

export async function nativeSTT(): Promise<NativeSTT | null> {
  if (!isNative()) return null;
  try {
    const mod = await import("@capacitor-community/speech-recognition");
    return mod.SpeechRecognition as unknown as NativeSTT;
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
    return registerPlugin<NativeWhisper>("LocalTranscription");
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
