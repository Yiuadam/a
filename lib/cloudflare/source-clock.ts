/**
 * Canonical UTC clock used for ordered Supabase -> D1 replication.
 *
 * JavaScript's Date truncates PostgreSQL's microseconds. Keep the source
 * fraction, while converting its offset to UTC, and pad to nine digits so a
 * plain SQLite text comparison is a precise chronological comparison.
 */
export function canonicalCloudflareSourceClock(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("Invalid Cloudflare replica source clock");
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/i
    .exec(value);
  if (!match) {
    return new Date(parsed).toISOString().replace(/(\.\d{3})Z$/, "$1000000Z");
  }
  const fraction = (match[2] ?? "").padEnd(9, "0").slice(0, 9);
  const second = new Date(Math.floor(parsed / 1000) * 1000).toISOString().slice(0, 19);
  return `${second}.${fraction}Z`;
}

export function currentCloudflareSourceClock(): string {
  return canonicalCloudflareSourceClock(new Date().toISOString());
}

/**
 * The same clock, cut to the precision the mirror can actually carry.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 *
 * PostgreSQL keeps timestamps to the microsecond. Everything that copies a row
 * into D1 passes through JavaScript, and a `Date` holds milliseconds — so the
 * last three digits are gone before the value reaches Cloudflare, on every
 * write, by construction.
 *
 * The parity fingerprints did not know that. The source side hashed
 * `to_char(..., '…MI:SS.US"Z"')` — six digits, straight from Postgres — and the
 * target side hashed what D1 had, which was those six digits with three zeros
 * on the end. A row stored at `.673830` was therefore compared as `.673830Z`
 * against `.673000Z` and declared different.
 *
 * Different every time, for every row whose microseconds were not already
 * zero. On this database that was 123 of 123 usage events, 15 of 15 progress
 * snapshots, 3 of 3 AI cost events and the single cost-coverage row — four
 * domains reading as wholly corrupt while the mirror was copying them
 * perfectly. The domains that came back equal were the ones that happen to
 * carry few timestamps, which is why the fault looked like a data problem
 * rather than a measurement one.
 *
 * ---------------------------------------------------------------------------
 * Why milliseconds, and why truncation
 *
 * Milliseconds because that is the most the target can hold: comparing at a
 * finer grain than the transport can carry asks a question no healthy mirror
 * could ever pass. Truncation rather than rounding because that is what the
 * write path already does — `Date.parse('…673830Z')` is 673, not 674 — so this
 * agrees with the value D1 actually stores rather than with a tidier one.
 *
 * The replication clock itself is untouched and still keeps all nine digits.
 * Ordering wants every digit it can get; equality wants only the digits both
 * sides hold. See canonicalCloudflareSourceClock above.
 */
export function parityClock(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return canonicalCloudflareSourceClock(value).replace(/\.(\d{3})\d{6}Z$/, ".$1Z");
  } catch {
    return null;
  }
}
