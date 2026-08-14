import { assertServerOnly } from "@/lib/auth/server-only";
import { avatarUrlSigningKey } from "@/lib/auth/env";

const MODULE = "lib/cloudflare/avatar-delivery.ts";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const AVATAR_URL_TTL_SECONDS = 60 * 60;
const MAX_GRANT_SECONDS = AVATAR_URL_TTL_SECONDS + 60;

export interface CloudflareAvatarGrant {
  userId: string;
  objectKey: string;
  expiresAt: number;
}

interface AvatarGrantPayload {
  v: 1;
  u: string;
  k: string;
  e: number;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function signingSecret(provided?: string): string | null {
  if (provided !== undefined) return provided.length >= 32 ? provided : null;
  assertServerOnly(MODULE);
  const secret = avatarUrlSigningKey();
  return secret && secret.length >= 32 ? secret : null;
}

export function cloudflareAvatarDeliveryConfigured(): boolean {
  return signingSecret() !== null;
}

/**
 * A browser-loadable, short-lived URL for one exact private R2 avatar.
 *
 * Images cannot attach BandUp's Authorization header, so the grant itself is
 * the bearer credential. It contains no secret; an HMAC covers the owner,
 * object key and expiry. The delivery route additionally requires D1 to still
 * point at that exact key, which makes a replaced or removed avatar URL stop
 * working immediately even before its hour expires.
 */
export async function cloudflareAvatarUrl(
  requestUrl: string,
  userId: string,
  objectKey: string,
  options: { nowSeconds?: number; secret?: string } = {},
): Promise<string | null> {
  const secret = signingSecret(options.secret);
  if (!secret) return null;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const payload: AvatarGrantPayload = {
    v: 1,
    u: userId,
    k: objectKey,
    e: now + AVATAR_URL_TTL_SECONDS,
  };
  const token = base64Url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(token)),
  );
  const url = new URL("/api/account/avatar/file", requestUrl);
  url.searchParams.set("grant", `${token}.${base64Url(signature)}`);
  return url.toString();
}

/** Verify a grant without trusting any of its decoded fields first. */
export async function verifyCloudflareAvatarGrant(
  value: string | null,
  options: { nowSeconds?: number; secret?: string } = {},
): Promise<CloudflareAvatarGrant | null> {
  const secret = signingSecret(options.secret);
  if (!secret || !value || value.length > 4096) return null;
  const separator = value.indexOf(".");
  if (separator < 1 || separator !== value.lastIndexOf(".")) return null;
  const token = value.slice(0, separator);
  const signature = fromBase64Url(value.slice(separator + 1));
  const encodedPayload = fromBase64Url(token);
  if (!signature || signature.byteLength !== 32 || !encodedPayload) return null;

  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    Uint8Array.from(signature).buffer,
    encoder.encode(token),
  );
  if (!valid) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(decoder.decode(encodedPayload)) as unknown;
  } catch {
    return null;
  }
  const grant = payload as Partial<AvatarGrantPayload>;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (
    grant.v !== 1
    || typeof grant.u !== "string"
    || grant.u.length < 1
    || grant.u.length > 128
    || typeof grant.k !== "string"
    || grant.k.length < 1
    || grant.k.length > 512
    || !Number.isInteger(grant.e)
    || (grant.e as number) <= now
    || (grant.e as number) > now + MAX_GRANT_SECONDS
  ) {
    return null;
  }

  const owner = grant.u.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
  if (!grant.k.startsWith(`private/avatars/${owner}/`)) return null;
  return { userId: grant.u, objectKey: grant.k, expiresAt: grant.e as number };
}
