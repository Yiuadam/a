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
