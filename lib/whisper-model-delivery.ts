/*
  The two public, English-only Whisper weights we allow BandUp to relay.

  This is deliberately an allowlist rather than a URL parameter. The fallback
  route is for a learner whose network blocks Hugging Face, not a general
  purpose proxy paid for by BandUp.
*/
const WHISPER_MODEL_ORIGIN = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

export const WHISPER_MODEL_FILES = [
  "ggml-tiny.en.bin",
  "ggml-base.en.bin",
] as const;

export type WhisperModelFile = (typeof WHISPER_MODEL_FILES)[number];

export function whisperModelSource(file: string | null): URL | null {
  if (!file || !(WHISPER_MODEL_FILES as readonly string[]).includes(file)) return null;
  return new URL(file, `${WHISPER_MODEL_ORIGIN}/`);
}

/*
  A model response can be 148 MB. Keep its body as the upstream stream and
  copy only the headers the browser's resumable downloader needs. In
  particular, Content-Range and Content-Length must agree with the bytes being
  streamed; losing either turns a resumed download into a corrupt model.
*/
const FORWARDED_HEADERS = [
  "Accept-Ranges",
  "Content-Length",
  "Content-Range",
  "Content-Type",
  "ETag",
] as const;

export function whisperModelResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers({
    // Cache Storage in the learner's browser owns the persistent copy. Do not
    // ask an edge cache to retain a second, 75–145 MB copy for every region.
    "Cache-Control": upstream.get("Cache-Control") ?? "no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  });
  for (const name of FORWARDED_HEADERS) {
    const value = upstream.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}
