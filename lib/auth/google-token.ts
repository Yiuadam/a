import { assertServerOnly } from "./server-only";

const MODULE = "lib/auth/google-token.ts";
const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

export interface VerifiedGoogleIdentity {
  subject: string;
  email: string;
  emailVerified: true;
}

/** Google Identity Services hashes its nonce; the server code flow returns it verbatim. */
export type GoogleNonceEncoding = "sha256" | "raw";

interface GoogleJwk {
  kty?: unknown;
  kid?: unknown;
  use?: unknown;
  alg?: unknown;
  n?: unknown;
  e?: unknown;
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/")
      + "=".repeat((4 - (value.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
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

async function nonceDigest(nonce: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verificationKey(kid: string): Promise<CryptoKey | null> {
  let response: Response;
  try {
    response = await fetch(GOOGLE_JWKS, { cache: "force-cache" });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: { keys?: unknown } | null = null;
  try {
    body = await response.json() as { keys?: unknown };
  } catch {
    return null;
  }
  const key = Array.isArray(body?.keys)
    ? body.keys.find((candidate): candidate is GoogleJwk => (
      Boolean(candidate) && typeof candidate === "object"
        && (candidate as GoogleJwk).kid === kid
        && (candidate as GoogleJwk).kty === "RSA"
        && (candidate as GoogleJwk).alg === "RS256"
        && (candidate as GoogleJwk).use === "sig"
    ))
    : null;
  if (!key) return null;
  try {
    return await crypto.subtle.importKey(
      "jwk",
      key as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }
}

/**
 * Verifies the Google signature and the claims Google requires a relying party
 * to check. The Google `sub`, never an email address, is the durable identity
 * key; the verified email is only used for the one-time legacy-account match.
 */
export async function verifyGoogleIdToken(
  token: string,
  /*
    One audience or several, because BandUp has more than one Google client and
    a token names exactly one of them. The website's button mints a token whose
    `aud` is the web client; the iOS app's own sign-in mints one whose `aud` is
    the iOS client, which is a different string and a different registration.
    Accepting a list is not a loosening: every entry is a client this project
    owns, and a token addressed to anybody else's client still fails.
  */
  expectedAudience: string | readonly string[],
  rawNonce: string,
  now = Date.now(),
  nonceEncoding: GoogleNonceEncoding = "sha256",
): Promise<VerifiedGoogleIdentity | null> {
  assertServerOnly(MODULE);
  const audiences = (typeof expectedAudience === "string" ? [expectedAudience] : expectedAudience)
    .filter((value) => typeof value === "string" && value.length > 0);
  if (!token || token.length > 16_384 || audiences.length === 0 || !rawNonce || rawNonce.length > 256) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = jsonPart(headerPart);
  const payload = jsonPart(payloadPart);
  const signature = decodeBase64Url(signaturePart);
  if (
    !header || header.alg !== "RS256" || typeof header.kid !== "string"
    || !payload || !signature
  ) return null;

  const key = await verificationKey(header.kid);
  if (!key) return null;
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, ownedBuffer(signature), signed)) return null;

  const nowSeconds = Math.floor(now / 1000);
  const subject = typeof payload.sub === "string" ? payload.sub : "";
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const nonce = typeof payload.nonce === "string" ? payload.nonce : "";
  if (
    subject.length < 1 || subject.length > 255
    || email.length < 3 || email.length > 254
    || (payload.email_verified !== true && payload.email_verified !== "true")
    || typeof payload.aud !== "string"
    || !audiences.includes(payload.aud)
    || typeof payload.iss !== "string" || !GOOGLE_ISSUERS.has(payload.iss)
    || typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= nowSeconds
    || nonce !== (nonceEncoding === "raw" ? rawNonce : await nonceDigest(rawNonce))
  ) return null;

  return { subject, email, emailVerified: true };
}
