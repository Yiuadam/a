import { getCloudflareContext } from "@opennextjs/cloudflare";
import { withCors } from "@/lib/http/cors";
import {
  LISTENING_AUDIO_MODEL,
  bundledListeningAudio,
  parseSingleRange,
  type ByteRange,
} from "@/lib/listening-audio";

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
  A real media response for the reviewed listening catalogue.

  The browser may not provide SpeechSynthesis or WebAudio (notably in some
  embedded browsers). A native `<audio>` element can still play this MPEG
  response. It is deliberately not a general `text=` endpoint: callers can
  only request the fixed paper scripts in lib/listening-audio.ts. On a cache
  miss Workers AI creates one MP3 and R2 stores it under a content-versioned
  immutable key; later learners only read the object.
*/
async function handleGET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const source = bundledListeningAudio(url.searchParams.get("id"));
  if (!source) return unavailable(404);
  const rawPart = url.searchParams.get("part") ?? "0";
  if (!/^\d+$/u.test(rawPart)) return unavailable(404);
  const part = Number(rawPart);
  if (!Number.isSafeInteger(part) || part < 0 || part >= source.parts.length) return unavailable(404);
  const segment = source.parts[part];
  if (!hasExactMediaTokens(url, {
    id: source.id,
    part: String(part),
    v: segment.contentVersion,
    voice: segment.voice,
    hash: segment.contentHash,
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
    cached = await env.BANDUP_FILES.head(segment.cacheKey);
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
    const object = await env.BANDUP_FILES.get(segment.cacheKey, range ? { range } : undefined);
    if (!object) return unavailable(503);
    return r2AudioResponse(object, cached.size, range);
  }

  if (!env.AI || !env.AUDIO_GENERATION_RATE_LIMITER) return unavailable(503);
  try {
    const { success } = await env.AUDIO_GENERATION_RATE_LIMITER.limit({ key: segment.cacheKey });
    if (!success) return rateLimited();
  } catch {
    return unavailable(503);
  }

  let generated: Response;
  try {
    /*
      The model travels with the roster rather than sitting here, because Aura
      shares speaker names across its two models and disagrees about their
      accents. A model named in the route could be changed without the voices
      beside it, which recasts every paper in the app and fails nowhere.
    */
    generated = await env.AI.run(
      LISTENING_AUDIO_MODEL,
      { text: segment.text, speaker: segment.voice, encoding: "mp3" },
      { returnRawResponse: true },
    );
  } catch (error) {
    // Keep the client response deliberately generic, but preserve the provider
    // diagnostic in the Worker log so an unavailable model binding is not
    // indistinguishable from a bad browser audio implementation.
    console.error("[listening-audio] Aura generation failed", error);
    return unavailable(502);
  }
  if (!generated.ok || !generated.body) {
    console.error("[listening-audio] Aura returned an unusable response", generated.status);
    return unavailable(502);
  }

  // One reviewed dialogue line is a bounded response. Buffering it lets us
  // write the verified MP3 to R2 and serve it to the first learner immediately;
  // later dialogue turns and range requests stream straight from R2.
  let audio: ArrayBuffer;
  try {
    audio = await generated.arrayBuffer();
  } catch {
    return unavailable(502);
  }
  if (audio.byteLength < 8) return unavailable(502);

  try {
    await env.BANDUP_FILES.put(segment.cacheKey, audio, {
      httpMetadata: { contentType: "audio/mpeg", cacheControl: AUDIO_HEADERS["Cache-Control"] },
      customMetadata: {
        kind: "bundled-listening-audio",
        testId: source.id,
        part: String(part),
        speaker: segment.speaker,
        voice: segment.voice,
      },
    });
  } catch {
    // Do not make the first valid generated response disappear merely because
    // the cache write failed. The next request may generate again, but the
    // learner can still hear this click's recording.
  }

  return new Response(audio, { headers: AUDIO_HEADERS });
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
