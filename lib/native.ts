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
