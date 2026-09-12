import { getCloudflareContext } from "@opennextjs/cloudflare";
import { withCors } from "@/lib/http/cors";
import { parseSingleRange, type ByteRange } from "@/lib/listening-audio";
import { LISTENING_FRAME_AUDIO_MODEL, bundledListeningFrameAudio } from "@/lib/listening-frame-audio";

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
  The narrator's frame around a listening recording — the part introduction,
  reading time, the cue to begin, the mid-part pause, the line that closes a
  part — served the same way app/api/examiner-audio/route.ts serves the
  speaking examiner's fixed prompts: an id is validated by being
  reconstructed from scratch rather than trusted, so this endpoint can never
  become a general TTS proxy the way a `text=` parameter would be. See
  lib/listening-frame-audio.ts for what an id is allowed to name — in
  particular why a sitting-relative question number embedded in it is
  checked against the papers' own uniform question count rather than
  accepted as given.
*/
async function handleGET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const source = bundledListeningFrameAudio(url.searchParams.get("id"));
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
    generated = await env.AI.run(
      LISTENING_FRAME_AUDIO_MODEL,
      { text: source.text, speaker: source.voice, encoding: "mp3" },
      { returnRawResponse: true },
    );
  } catch (error) {
    // Keep the client response generic, but preserve the provider diagnostic
    // in the Worker log so an unavailable model binding is not
    // indistinguishable from a bad browser audio implementation.
    console.error("[listening-frame-audio] Aura generation failed", error);
    return unavailable(502);
  }
  if (!generated.ok || !generated.body) {
    console.error("[listening-frame-audio] Aura returned an unusable response", generated.status);
    return unavailable(502);
  }

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
        kind: "bundled-listening-frame-audio",
        promptId: source.id,
        voice: source.voice,
      },
    });
  } catch {
    // Do not make the first valid generated response disappear merely
    // because the cache write failed. The next request may generate again,
    // but the learner can still hear this click's recording.
  }

  return new Response(audio, { headers: AUDIO_HEADERS });
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
