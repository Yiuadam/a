import { assertServerOnly } from "./server-only";

/*
  Verifying what Apple says about who somebody is.

  This is the same job lib/auth/google-token.ts does, written the same way and
  deliberately kept close enough to it that the two can be read side by side.
  Where it differs, it differs because Apple differs, and each of those places
  is commented — they are the places a mistake would be invisible.

  Three of them matter more than the rest.

  The audience is not one value. A Google identity token is always addressed to
  one client id, so that file compares against one string. Apple issues tokens
  to two clients that are both ours: the Services ID, which is the web flow's
  identity, and the app's bundle id, which is the native flow's. A token
  addressed to either is a token Apple minted for BandUp; a token addressed to
  anything else is somebody else's, and accepting it would let any other Apple
  developer's identity token sign a person in here as whoever it names.

  The email is not the identity. It is not even reliably present, and when it
  is present it may be a Private Relay address — @privaterelay.appleid.com,
  generated per app, and revocable from the learner's Apple ID settings without
  telling us. Someone can also change the address behind it, or turn relaying
  off later and start arriving with their real one. `sub` is the only claim that
  is stable for the life of the account, so `sub` is what an account is keyed
  on. Keying on the email would merge two people who happened to share a
  forwarded address, or orphan somebody the day they changed it, and neither is
  recoverable afterwards.

  The nonce is echoed, not hashed. Google Identity Services hashes the nonce it
  is given before putting it in the token, which is why the Google verifier
  hashes before comparing. Apple does neither: whatever string was put on the
  request comes back verbatim. That is not a weaker guarantee, it just moves who
  does the hashing — the native flow hashes on the device so the raw value never
  leaves it, and this file is told which of the two it is looking at.
*/

const MODULE = "lib/auth/apple-token.ts";
const APPLE_JWKS = "https://appleid.apple.com/auth/keys";

/*
  Exactly this string, with no second spelling accepted.

  Google is checked against a set of two because Google genuinely issues both
  `accounts.google.com` and `https://accounts.google.com` and has done for
  years. Apple issues one. A set of one would invite somebody to add to it.
*/
const APPLE_ISSUER = "https://appleid.apple.com";

/**
 * The native client's audience: this app's bundle id.
 *
 * Fixed rather than configured, because it is fixed — it is the identifier the
 * binary is signed with, and a deployment cannot choose a different one at
 * runtime without shipping a different app. It must stay equal to `appId` in
 * capacitor.config.ts and PRODUCT_BUNDLE_IDENTIFIER in the Xcode project;
 * tests/apple-signin.test.mjs fails if the three ever drift apart, which is the
 * only way this constant could go wrong quietly.
 */
export const APPLE_NATIVE_AUDIENCE = "com.yiuadam.bandup";

/**
 * Everything downstream is allowed to know about an Apple sign-in.
 *
 * `email` is nullable and `emailVerified` can be false, which is a real state
 * rather than a defensive one: a learner may decline to share an address at
 * all. Callers must not treat a null email as a failure — the account is
 * identified by `subject`, and an address is a convenience the rest of the app
 * degrades without.
 */
export interface VerifiedAppleIdentity {
  /** Apple's stable `sub`. The only durable identifier in the token. */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  /** True when the address forwards through Apple's Private Relay. */
  isPrivateEmail: boolean;
}

/** The native flow hashes its nonce on the device; the web flow sends it raw. */
export type AppleNonceEncoding = "sha256" | "raw";

interface AppleJwk {
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

/**
 * Apple's own signing key for this token, fetched from Apple.
 *
 * The `kid` is read from the token's header and used only to *select* among
 * keys Apple published. Nothing in the token is ever imported as a key: a JWT
 * that carries its own verification key verifies itself, which is the oldest
 * mistake in this family of bugs and the reason this function takes a key id
 * rather than a key.
 *
 * `force-cache` is how the Google verifier avoids a round trip to the JWKS on
 * every sign-in, and the same reasoning holds here: Apple's key set is public,
 * long-lived and served with cache headers Cloudflare will honour. Apple
 * rotates it and publishes the new key well before it signs with it, so a
 * cached set that has fallen behind produces a miss on the `kid` and a rejected
 * token rather than an accepted forgery — the safe direction.
 */
async function verificationKey(kid: string): Promise<CryptoKey | null> {
  let response: Response;
  try {
    response = await fetch(APPLE_JWKS, { cache: "force-cache" });
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
    ? body.keys.find((candidate): candidate is AppleJwk => {
      if (!candidate || typeof candidate !== "object") return false;
      const jwk = candidate as AppleJwk;
      /*
        Matched on the two fields that decide which key this is, and not on
        `use` or `alg`.

        The Google verifier does insist on both, and that is right there
        because Google's key set has always carried them. Apple's carries them
        today too — but requiring a field for a security property it does not
        actually provide is how a verifier ends up rejecting every token on
        the morning a provider adds a key with one field omitted, and that
        failure is a total sign-in outage rather than a narrowing.

        Nothing is given up by leaving them out, because neither field is
        trusted for anything even when present. The algorithm is pinned twice
        below, by this file: the header must say RS256, and the key is
        imported as RSASSA-PKCS1-v1_5 over SHA-256 whatever the JWK claims.
        importKey itself refuses a JWK whose own `alg` or `use` contradicts
        that, so a mislabelled key fails to import rather than verifying
        something under an algorithm nobody chose.
      */
      return jwk.kid === kid && jwk.kty === "RSA";
    })
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
 * True when `aud` names a client that is ours, and no client that is not.
 *
 * Apple sends a string, and every token seen in the wild is a string. The array
 * form is legal JWT, so it is handled rather than rejected outright — but
 * handled by requiring *every* entry to be one of ours. The obvious reading,
 * "one of the entries is ours", is the wrong one: it would accept a token that
 * is addressed to us and to somebody else at the same time, which is a shape
 * this app has no use for and cannot reason about.
 */
function audienceIsOurs(aud: unknown, expected: ReadonlySet<string>): boolean {
  if (typeof aud === "string") return expected.has(aud);
  if (Array.isArray(aud)) {
    return aud.length > 0 && aud.every((value) => typeof value === "string" && expected.has(value));
  }
  return false;
}

/**
 * Apple spells its booleans inconsistently.
 *
 * `email_verified` and `is_private_email` arrive as real booleans from some
 * endpoints and as the strings "true"/"false" from others; which one you get
 * has changed over the years and is not something to depend on. The Google
 * verifier already carries the same two-spelling test for `email_verified`,
 * for the same reason.
 */
function appleBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * How far out of step Apple's clock and this Worker's may be before a token
 * that is genuinely current looks like one from the future.
 *
 * Only `iat` is given this allowance. `exp` is not: letting an expired token
 * through for another two minutes would be widening the replay window to buy
 * nothing, since an Apple identity token is presented within seconds of being
 * issued in both of this app's flows.
 */
const CLOCK_SKEW_SECONDS = 120;

/**
 * The oldest `iat` that is still credible.
 *
 * `exp` is what actually bounds the token — Apple's identity tokens live about
 * ten minutes — so this is a second, looser fence rather than the real one. It
 * exists because `exp` is a claim like any other and a token with a wildly
 * backdated `iat` and a generous `exp` is not a shape Apple produces; refusing
 * it costs nothing and describes the expectation out loud.
 */
const MAX_TOKEN_AGE_SECONDS = 60 * 60;

/**
 * Verifies Apple's signature and every claim a relying party is obliged to
 * check, and returns nothing at all if any of them is wrong.
 *
 * Null for every failure, with no indication of which one: this is called from
 * request handlers that answer a single "sign-in could not be completed"
 * regardless, and a verifier that distinguished "wrong audience" from "bad
 * signature" would be an oracle for whoever is trying them.
 *
 * @param expectedAudiences The client ids that are ours — the Services ID for
 *   the web flow and the bundle id for the native one. Never widen this.
 * @param rawNonce The nonce this side generated for this one sign-in.
 * @param nonceEncoding Whether the caller sent Apple that nonce as-is (the web
 *   flow) or its SHA-256 hex digest (the native flow, which hashes on the
 *   device so the raw value never leaves it).
 */
export async function verifyAppleIdToken(
  token: string,
  expectedAudiences: readonly string[],
  rawNonce: string,
  now = Date.now(),
  nonceEncoding: AppleNonceEncoding = "raw",
): Promise<VerifiedAppleIdentity | null> {
  assertServerOnly(MODULE);
  const audiences = new Set(expectedAudiences.filter((value) => typeof value === "string" && value.length > 0));
  if (!token || token.length > 16_384 || audiences.size === 0 || !rawNonce || rawNonce.length > 256) {
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
  const nonce = typeof payload.nonce === "string" ? payload.nonce : "";
  const expected = nonceEncoding === "raw" ? rawNonce : await nonceDigest(rawNonce);
  if (
    subject.length < 1 || subject.length > 255
    || !audienceIsOurs(payload.aud, audiences)
    || payload.iss !== APPLE_ISSUER
    || typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= nowSeconds
    || typeof payload.iat !== "number" || !Number.isFinite(payload.iat)
    || payload.iat > nowSeconds + CLOCK_SKEW_SECONDS
    || payload.iat < nowSeconds - MAX_TOKEN_AGE_SECONDS
    /*
      A device too old to support the nonce is refused rather than waved
      through. Apple sets `nonce_supported: false` and omits the claim
      entirely on systems from before it was introduced, and a verifier that
      accepted that has no replay protection at all for exactly the callers
      most likely to be forged. The project's deployment target is iOS 15, so
      there is no real device this turns away.
    */
    || payload.nonce_supported === false
    || nonce !== expected
  ) return null;

  /*
    The address, if there is one, normalised the way every other address in this
    app is — trimmed and lower-cased — so that a match against a stored one is
    between two canonical forms. Absent is a legitimate answer and stays null;
    it is never turned into an empty string, because an empty string would land
    in the unique-email index as a value and collide with the next learner who
    also declined to share.
  */
  const rawEmail = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const email = rawEmail.length >= 3 && rawEmail.length <= 254 ? rawEmail : null;

  return {
    subject,
    email,
    emailVerified: email !== null && appleBoolean(payload.email_verified),
    isPrivateEmail: appleBoolean(payload.is_private_email),
  };
}
