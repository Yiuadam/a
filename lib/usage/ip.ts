import { assertServerOnly } from "@/lib/auth/server-only";
import { ipHashSalt } from "@/lib/auth/env";

/*
  Identifying the caller's address well enough to rate limit, without keeping a
  log of who was where.

  The address is never stored. What is stored is an HMAC of it under a salt
  that only the server holds. That is enough to count requests from one address
  and useless for finding out which address — provided the salt exists, which
  is why its absence disables IP limiting rather than falling back to a plain
  hash. A plain SHA-256 of an IPv4 address is reversible by trying all four
  billion of them, so it is a plaintext address with extra steps.
*/

const MODULE = "lib/usage/ip.ts";

/**
 * The client address as reported by the platform's proxy.
 *
 * `x-forwarded-for` is client-controlled in general — anyone can send one.
 * On Vercel and on Cloudflare the edge overwrites it with the real peer
 * address before the function sees it, so on those platforms the leftmost
 * entry is trustworthy. Deployed anywhere without a proxy that does this, the
 * header must not be believed; that is a deployment property, not a code one,
 * and it is called out in ACCOUNTS.md.
 */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || null;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * HMAC-SHA256 of the address under the server salt, truncated to 32 hex
 * characters — plenty to keep collisions negligible at this scale, and shorter
 * to index.
 *
 * Returns null when there is no salt or no address, and the meter then skips
 * the per-address ceiling rather than pretending to enforce one.
 */
export async function hashIp(ip: string | null): Promise<string | null> {
  assertServerOnly(MODULE);
  const salt = ipHashSalt();
  if (!ip || !salt) return null;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(ip));
  return toHex(signature).slice(0, 32);
}
