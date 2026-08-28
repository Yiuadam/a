import { assertServerOnly } from "./server-only";
import type { AuthedUser } from "./supabase";

/*
  The application session is intentionally small and self-contained. It is
  not an OAuth token and must never be accepted by Google or any other
  provider; it only authenticates a BandUp API request after this Worker has
  already verified a Google credential and linked it to a D1 user record.
*/

const MODULE = "lib/auth/native-session.ts";
const ISSUER = "bandup.cloudflare";
const AUDIENCE = "bandup-api";
export const ACCESS_TOKEN_SECONDS = 60 * 60;

export interface NativeSessionPayload {
  iss: typeof ISSUER;
  aud: typeof AUDIENCE;
  sub: string;
  email: string | null;
  sid: string;
  iat: number;
  exp: number;
}

/**
 * A verified access token is deliberately richer than the public user shape:
 * the session id is needed by the server-side D1 revocation check, but it must
 * never become a client-side account field.
 */
export interface VerifiedNativeAccessToken {
  user: AuthedUser;
  sessionId: string;
  expiresAt: number;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/")
      + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function jsonPart(value: string): Record<string, unknown> | null {
  const bytes = decodeBase64Url(value);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(value: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    new TextEncoder().encode(value),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

function isPayload(value: Record<string, unknown>): value is Record<string, unknown> & NativeSessionPayload {
  return value.iss === ISSUER
    && value.aud === AUDIENCE
    && typeof value.sub === "string"
    && value.sub.length >= 16
    && value.sub.length <= 80
    && (typeof value.email === "string" || value.email === null)
    && typeof value.sid === "string"
    && value.sid.length >= 16
    && typeof value.iat === "number"
    && Number.isInteger(value.iat)
    && typeof value.exp === "number"
    && Number.isInteger(value.exp)
    && value.exp > value.iat;
}

/** Creates a one-hour API token; refresh credentials live only in D1. */
export async function createNativeAccessToken(
  user: Pick<AuthedUser, "id" | "email">,
  sessionId: string,
  secret: string,
  now = Date.now(),
): Promise<{ accessToken: string; expiresAt: number }> {
  assertServerOnly(MODULE);
  const issuedAt = Math.floor(now / 1000);
  const payload: NativeSessionPayload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: user.id,
    email: user.email,
    sid: sessionId,
    iat: issuedAt,
    exp: issuedAt + ACCESS_TOKEN_SECONDS,
  };
  const header = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const unsigned = `${header}.${body}`;
  return { accessToken: `${unsigned}.${await sign(unsigned, secret)}`, expiresAt: payload.exp * 1000 };
}

/** True only for a token that claims to be a BandUp-native session. */
export function looksLikeNativeAccessToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const payload = jsonPart(parts[1]);
  return payload?.iss === ISSUER && payload?.aud === AUDIENCE;
}

/** Verifies signature, issuer, audience and expiry before returning its session. */
export async function verifyNativeAccessToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<VerifiedNativeAccessToken | null> {
  assertServerOnly(MODULE);
  if (!token || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = jsonPart(headerPart);
  const payload = jsonPart(payloadPart);
  const signature = decodeBase64Url(signaturePart);
  if (!header || header.alg !== "HS256" || header.typ !== "JWT" || !payload || !signature || !isPayload(payload)) {
    return null;
  }
  const verified = await crypto.subtle.verify(
    "HMAC",
    await signingKey(secret),
    ownedBuffer(signature),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!verified || payload.exp * 1000 <= now || payload.iat * 1000 > now) return null;
  return {
    user: { id: payload.sub, email: payload.email, createdAt: null },
    sessionId: payload.sid,
    expiresAt: payload.exp * 1000,
  };
}

/**
 * Compatibility helper for callers that need only a signed claim. Request
 * authentication additionally validates the returned session against D1 in
 * lib/cloudflare/native-identity.ts, so a revoked session stops immediately.
 */
export async function userFromNativeAccessToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<AuthedUser | null> {
  return (await verifyNativeAccessToken(token, secret, now))?.user ?? null;
}

export function randomSessionToken(bytes = 48): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return encodeBase64Url(value);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
