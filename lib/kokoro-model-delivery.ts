/*
  The only public Kokoro assets BandUp's built-in examiner needs.

  The browser runtime bundled in public/vendor/kokoro has its Hugging Face host
  compiled in. Keeping this list here gives the client a safe rewrite target
  and gives the Worker a hard boundary: this must never become an open proxy.
*/
export const KOKORO_MODEL_ORIGIN = "https://huggingface.co";
export const KOKORO_MODEL_REPOSITORY = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const KOKORO_MODEL_REVISION = "main";

export const KOKORO_MODEL_ASSETS = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  // `dtype: \"q8\"` in lib/neural-speech resolves to this transformers.js
  // weight; do not silently relay the much larger unquantised variants.
  "onnx/model_quantized.onnx",
] as const;

export type KokoroModelAsset = (typeof KOKORO_MODEL_ASSETS)[number];

export const KOKORO_VOICE_ASSET = "voices/bf_emma.bin";
export const KOKORO_LOCAL_VOICE_PATH = "/vendor/kokoro/bf_emma.bin";

const HUB_PATH_PREFIX = `/${KOKORO_MODEL_REPOSITORY}/resolve/${KOKORO_MODEL_REVISION}/`;

export function kokoroModelSource(asset: string | null): URL | null {
  if (!asset || !(KOKORO_MODEL_ASSETS as readonly string[]).includes(asset)) return null;
  return new URL(`${HUB_PATH_PREFIX}${asset}`, KOKORO_MODEL_ORIGIN);
}

/**
 * Turn the runtime's fixed public Hub URLs into their same-origin equivalents.
 * No other host, repository, revision, query, or asset is accepted.
 */
export function kokoroSameOriginAssetPath(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.origin !== KOKORO_MODEL_ORIGIN || url.search || url.hash) return null;
  if (!url.pathname.startsWith(HUB_PATH_PREFIX)) return null;

  const asset = url.pathname.slice(HUB_PATH_PREFIX.length);
  if (asset === KOKORO_VOICE_ASSET) return KOKORO_LOCAL_VOICE_PATH;
  if (!(KOKORO_MODEL_ASSETS as readonly string[]).includes(asset)) return null;

  const target = new URL("/api/kokoro-model", url.origin);
  target.searchParams.set("asset", asset);
  return `${target.pathname}${target.search}`;
}

/* Keep the response streaming: the q8 file is about 92 MB. */
const FORWARDED_HEADERS = [
  "Accept-Ranges",
  "Content-Length",
  "Content-Range",
  "Content-Type",
  "ETag",
] as const;

export function kokoroModelResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers({
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
