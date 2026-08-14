import { cloudflareDataMode } from "@/lib/cloudflare/bindings";
import { verifyCloudflareAvatarGrant } from "@/lib/cloudflare/avatar-delivery";
import { getCloudflareAvatarObject } from "@/lib/cloudflare/learner-data";
import { logInternal } from "@/lib/auth/errors";
import { withCors } from "@/lib/http/cors";

export const dynamic = "force-dynamic";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function unavailable(status = 404): Response {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Private R2 delivery through the Worker binding.
 *
 * There is deliberately no public R2 URL and no cookie/bearer requirement:
 * plain <img> requests cannot attach BandUp's Authorization header. Instead a
 * one-hour HMAC grant names one owner and one exact object. The live D1 pointer
 * must still agree, so another user's key, a removed key or an old key fails.
 */
async function handleGET(req: Request): Promise<Response> {
  if (cloudflareDataMode() !== "cloudflare") return unavailable();
  const grant = await verifyCloudflareAvatarGrant(new URL(req.url).searchParams.get("grant"));
  if (!grant) return unavailable();

  let object: R2ObjectBody | null;
  try {
    object = await getCloudflareAvatarObject(grant.userId, grant.objectKey);
  } catch (error) {
    logInternal("account/avatar/file GET", error);
    return unavailable(503);
  }
  if (!object) return unavailable();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const contentType = headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType || !IMAGE_TYPES.has(contentType)) return unavailable();
  const remaining = Math.max(0, grant.expiresAt - Math.floor(Date.now() / 1000));
  headers.set("Cache-Control", `private, max-age=${remaining}, immutable`);
  headers.set("Content-Length", String(object.size));
  headers.set("Content-Disposition", "inline");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("ETag", object.httpEtag);
  return new Response(object.body, { status: 200, headers });
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
