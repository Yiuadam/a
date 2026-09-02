import { getCloudflareContext } from "@opennextjs/cloudflare";
import { EXAMINER_AUDIO_MODEL, bundledExaminerAudio } from "@/lib/examiner-audio";
import { withCors } from "@/lib/http/cors";
import { parseSingleRange, type ByteRange } from "@/lib/listening-audio";

export const dynamic = "force-dynamic";

const AUDIO_HEADERS = {
  "Content-Type": "audio/mpeg",
  "Accept-Ranges": "bytes",
  "Cache-Control": "public, max-age=31536000, immutable",
  "X-Content-Type-Options": "nosniff",
} as const;
const RATE_LIMIT_RETRY_AFTER_SECONDS = "60";

function unavailable(status: number): Response {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function rateLimited(): Response {
  return new Response(null, {
    status: 429,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": RATE_LIMIT_RETRY_AFTER_SECONDS,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function hasExactMediaTokens(
  url: URL,
  expected: Readonly<Record<string, string>>,
): boolean {
  const names = [...url.searchParams.keys()];
  const expectedNames = Object.keys(expected);
  return names.length === expectedNames.length && expectedNames.every(
    (name) => url.searchParams.getAll(name).length === 1 && url.searchParams.get(name) === expected[name],
  );
}

function r2AudioResponse(object: R2ObjectBody, totalSize: number, range: ByteRange | null): Response {
  const headers = new Headers(AUDIO_HEADERS);
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", "audio/mpeg");
  headers.set("ETag", object.httpEtag);
  if (range) {
    headers.set("Content-Length", String(range.length));
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${totalSize}`);
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(totalSize));
  return new Response(object.body, { headers });
}

/*
  The examiner endpoint deliberately accepts a catalogue ID rather than text.
  Those IDs are assembled from the shipped speaking banks in lib/examiner-audio;
  a public caller therefore cannot use the Worker as an open TTS proxy.
*/
async function handleGET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const source = bundledExaminerAudio(url.searchParams.get("id"));
  if (!source) return unavailable(404);
  if (!hasExactMediaTokens(url, {
    id: source.id,
    v: source.contentVersion,
    voice: source.voice,
    hash: source.contentHash,
  })) return unavailable(404);

  let env: (CloudflareEnv & Env) | null = null;
  try {
    const context = await getCloudflareContext({ async: true });
    env = context.env as CloudflareEnv & Env;
  } catch {
    return unavailable(503);
  }
  if (!env.BANDUP_FILES) return unavailable(503);

  let cached: R2Object | null;
  try {
    cached = await env.BANDUP_FILES.head(source.cacheKey);
  } catch {
    return unavailable(503);
  }

  if (cached) {
    const rawRange = request.headers.get("Range");
    const range = parseSingleRange(rawRange, cached.size);
    if (rawRange && !range) {
      return new Response(null, {
        status: 416,
        headers: { ...AUDIO_HEADERS, "Content-Range": `bytes */${cached.size}` },
      });
    }
    const object = await env.BANDUP_FILES.get(source.cacheKey, range ? { range } : undefined);
    if (!object) return unavailable(503);
    return r2AudioResponse(object, cached.size, range);
  }

  if (!env.AI || !env.AUDIO_GENERATION_RATE_LIMITER) return unavailable(503);
  try {
    const { success } = await env.AUDIO_GENERATION_RATE_LIMITER.limit({ key: source.cacheKey });
    if (!success) return rateLimited();
  } catch {
    return unavailable(503);
  }

  let generated: Response;
  try {
    /*
      The model comes from the same module as the speaker, and deliberately so.
      Aura shares several speaker names across its two models with different
      accents behind them, so a model named here rather than there could be
      changed without the voice beside it — which is how a British examiner
      quietly becomes an American one with nothing failing anywhere.
    */
    generated = await env.AI.run(
      EXAMINER_AUDIO_MODEL,
      { text: source.text, speaker: source.voice, encoding: "mp3" },
      { returnRawResponse: true },
    );
  } catch (error) {
    console.error("[examiner-audio] Aura generation failed", error);
    return unavailable(502);
  }
  if (!generated.ok || !generated.body) return unavailable(502);

  let audio: ArrayBuffer;
  try {
    audio = await generated.arrayBuffer();
  } catch {
    return unavailable(502);
  }
  if (audio.byteLength < 8) return unavailable(502);

  try {
    await env.BANDUP_FILES.put(source.cacheKey, audio, {
      httpMetadata: { contentType: "audio/mpeg", cacheControl: AUDIO_HEADERS["Cache-Control"] },
      customMetadata: {
        kind: "bundled-examiner-audio",
        promptId: source.id,
        voice: source.voice,
        contentHash: source.contentHash,
      },
    });
  } catch {
    // The first valid audio stays playable even if its cache write is retried
    // later. R2 cache availability must not make an examiner prompt disappear.
  }

  return new Response(audio, { headers: AUDIO_HEADERS });
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
