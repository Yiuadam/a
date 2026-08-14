import { getCloudflareContext } from "@opennextjs/cloudflare";
import { withCors } from "@/lib/http/cors";
import { kokoroModelResponseHeaders, kokoroModelSource } from "@/lib/kokoro-model-delivery";

export const dynamic = "force-dynamic";
const RATE_LIMIT_RETRY_AFTER_SECONDS = "60";

function unavailable(status = 404): Response {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
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

async function enforceModelFetchLimit(request: Request, asset: string): Promise<Response | null> {
  let limiter: RateLimit | undefined;
  try {
    const context = await getCloudflareContext({ async: true });
    const env = context.env as CloudflareEnv & Env;
    limiter = env.MODEL_FETCH_RATE_LIMITER;
  } catch {
    // Plain `next dev` has no Worker bindings. A deployed Worker must always
    // fail closed rather than silently becoming an unmetered public relay.
    if (process.env.NODE_ENV === "development") return null;
    return unavailable(503);
  }

  const client = request.headers.get("CF-Connecting-IP")?.trim()
    || (process.env.NODE_ENV === "development" ? "local-development" : "");
  if (!limiter || !client) return unavailable(503);
  try {
    const { success } = await limiter.limit({ key: `kokoro:${asset}:${client}` });
    return success ? null : rateLimited();
  } catch {
    return unavailable(503);
  }
}

/*
  The client can only ask for a four-file allowlist. The Worker forwards the
  upstream stream and Range header unchanged, so it does not allocate the
  92 MB browser model in memory or become a generic external fetch proxy.
*/
async function handleGET(request: Request): Promise<Response> {
  const asset = new URL(request.url).searchParams.get("asset");
  const source = kokoroModelSource(asset);
  if (!asset || !source) return unavailable();

  const limited = await enforceModelFetchLimit(request, asset);
  if (limited) return limited;

  const range = request.headers.get("Range");
  let upstream: Response;
  try {
    upstream = await fetch(source, {
      cache: "no-store",
      headers: range ? { Range: range } : undefined,
    });
  } catch {
    return unavailable(502);
  }

  if (!upstream.body) return unavailable(upstream.status >= 400 ? upstream.status : 502);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: kokoroModelResponseHeaders(upstream.headers),
  });
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
