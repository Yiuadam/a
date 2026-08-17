/**
 * One canonical text form for a JSON document, computed identically in
 * JavaScript (this file) and in PostgreSQL
 * (`cloudflare_migration_canonical_json` in
 * `supabase/parity-payload-canonical.sql`), so the same logical document
 * hashes to the same value on both sides of the Supabase -> D1 mirror.
 *
 * ---------------------------------------------------------------------------
 * Why this exists, and the trap it exists to avoid
 *
 * `migration-readiness.ts` and `domain-drift.ts` compare `progress_snapshots`,
 * `subscriptions` and `provider_events` on their identity columns only —
 * `user_id`/`store_key`/`source_updated_at`, `id`, `provider`/`event_id`. The
 * payload column itself (`payload`, `raw`, `payload`) is never compared, so
 * D1 can hold a stale or corrupt copy of a learner's entire record and every
 * existing report still says `equal`. This module is what actually opens the
 * payload and proves the bytes match.
 *
 * The obvious approach — hash each side's own JSON serialisation — fails
 * before it starts. PostgreSQL's `jsonb` reorders object keys and does not
 * preserve the original spelling of a number (`1e2` becomes `100`, though —
 * verified against a live PostgreSQL 16 instance while writing this —
 * trailing fractional zeros are NOT stripped by jsonb itself: `'1.500'::jsonb`
 * stays `1.500`). JavaScript's `JSON.stringify` preserves insertion order and
 * prints a `number` with whatever spelling `Number#toString` chooses,
 * including scientific notation once the magnitude passes 1e21 or drops below
 * 1e-6. Hash either side's natural serialisation and a payload that is
 * genuinely byte-identical reads as 100% corrupt — the same shape of failure
 * `supabase/parity-canonical-evidence.sql` documents for microsecond
 * timestamps and for `cost_usd`.
 *
 * So neither side's native serialisation is used. Both sides instead walk the
 * document with the same rules and build the same string:
 *
 *   1. Object keys are sorted by ascending UTF-8 byte order (ties cannot
 *      occur: neither a `jsonb` object nor a `JSON.parse` result can hold a
 *      duplicate key — the later one wins during parsing, on both sides,
 *      before this ever runs).
 *   2. Array order is preserved as written; it is semantically significant.
 *   3. A string is written exactly as `JSON.stringify` would write a bare
 *      string — quote, backslash and the C0 control characters escaped,
 *      everything else (including `/` and non-ASCII) left alone. This was
 *      checked against PostgreSQL's own `to_json`/`jsonb::text` output, which
 *      escapes the same characters the same way, so both sides agree
 *      byte-for-byte for any string without an unpaired UTF-16 surrogate.
 *   4. A number is written as the minimal decimal PostgreSQL's `numeric` type
 *      would print for it: no leading zeros beyond a single digit, no
 *      trailing fractional zeros, no leading `+`, never scientific notation,
 *      and `-0` folded to `0` (`numeric` carries no signed zero). This is the
 *      same minimal spelling `parity-money.ts` /
 *      `cloudflare_migration_money_field` already use for `cost_usd`; the
 *      algorithm is reimplemented here rather than imported, because that
 *      helper is written for a value the app already guarantees is a plain,
 *      bounded decimal (never scientific notation to begin with) and
 *      deliberately leaves anything it does not recognise untouched — the
 *      wrong behaviour for an arbitrary payload number that `Number#toString`
 *      may have rendered in scientific notation on its own.
 *   5. `true`, `false` and `null` are written as those literal tokens.
 *   6. An object key that is entirely absent is omitted from the canonical
 *      form; a key explicitly holding JSON `null` is written as `null`. Both
 *      `jsonb` and `JSON.parse` already keep this distinction, so nothing
 *      extra is needed to preserve it — this point is written down because
 *      collapsing the two would be an easy, silent way to make a real
 *      difference invisible.
 *
 * The resulting string is UTF-8 encoded and SHA-256 hashed. Nothing here
 * transmits a stored payload anywhere; it only ever produces a hash.
 */

const utf8Encoder = new TextEncoder();

function compareUtf8Bytes(left: string, right: string): number {
  const a = utf8Encoder.encode(left);
  const b = utf8Encoder.encode(right);
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Expands `Number#toString`'s scientific notation ("1e+21", "1.5e-7") back
 * into plain decimal text. PostgreSQL's `numeric_out` never emits scientific
 * notation, so the canonical form must not either.
 */
function expandScientificNotation(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(text);
  if (!match) return text;
  const [, sign, wholePart, fractionPart = "", exponentText] = match;
  const exponent = Number(exponentText);
  const digits = wholePart + fractionPart;
  const pointIndex = wholePart.length + exponent;
  let combined: string;
  if (pointIndex <= 0) {
    combined = `0.${"0".repeat(-pointIndex)}${digits}`;
  } else if (pointIndex >= digits.length) {
    combined = `${digits}${"0".repeat(pointIndex - digits.length)}`;
  } else {
    combined = `${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
  }
  return sign + combined;
}

/**
 * The minimal decimal spelling for a JSON number — see rule 4 above. Kept
 * exported so a test can check it directly against values verified by hand
 * against a live PostgreSQL `numeric`.
 */
export function canonicalPayloadNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error("Cloudflare payload canonicalisation cannot hash a non-finite number");
  }
  const normalized = Object.is(value, -0) ? 0 : value;
  const plain = expandScientificNotation(normalized.toString());
  const trimmed = plain.includes(".")
    ? plain.replace(/(\.[0-9]*?)0+$/, "$1").replace(/\.$/, "")
    : plain;
  return trimmed === "-0" ? "0" : trimmed;
}

/**
 * Walks a JSON value (already parsed — from `JSON.parse` of a D1 inline or R2
 * payload) into the canonical text form described above. Throws on anything
 * that cannot appear in valid JSON (a function, a symbol, a non-finite
 * number, `undefined` at the top level): a payload that fails to canonicalise
 * is a payload the caller should report as unreadable, not one this silently
 * papers over.
 */
export function canonicalizePayloadJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  const type = typeof value;
  if (type === "boolean") return value ? "true" : "false";
  if (type === "number") return canonicalPayloadNumber(value as number);
  if (type === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizePayloadJson(item)).join(",")}]`;
  }
  if (type === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareUtf8Bytes);
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalizePayloadJson(record[key])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(`Cloudflare payload canonicalisation cannot hash a ${type}`);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const owned = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest("SHA-256", owned.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of the canonical form's UTF-8 bytes, hex-encoded. */
export async function canonicalPayloadHash(value: unknown): Promise<string> {
  return sha256Hex(utf8Encoder.encode(canonicalizePayloadJson(value)));
}
