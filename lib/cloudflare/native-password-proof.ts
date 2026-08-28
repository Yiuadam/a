/*
  Canonical, non-sensitive evidence for a one-time password-verifier import.

  The source export and D1 both contain bcrypt values while the import runs,
  but an owner-facing result must never.  This module produces one SHA-256
  commitment to the exact set instead.  It includes each immutable user id,
  source update time and verifier; equal row counts alone therefore cannot
  certify a wrong verifier attached to an otherwise correct account.
*/

export interface PasswordProofRow {
  userId: string;
  sourceUpdatedAt: string;
  verifier: string;
}

function field(value: string): string {
  return `${new TextEncoder().encode(value).byteLength}:${value}`;
}

function validDate(value: string): string | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Strictly validates a row before it becomes part of a migration commitment. */
export function normalisePasswordProofRow(value: PasswordProofRow): PasswordProofRow | null {
  const userId = typeof value.userId === "string" ? value.userId.trim() : "";
  const verifier = typeof value.verifier === "string" ? value.verifier : "";
  const sourceUpdatedAt = typeof value.sourceUpdatedAt === "string"
    ? validDate(value.sourceUpdatedAt)
    : null;
  if (userId.length < 16 || userId.length > 80 || verifier.length !== 60 || !sourceUpdatedAt) return null;
  return { userId, sourceUpdatedAt, verifier };
}

/**
 * Returns a hash over the complete canonical row set. It is safe to retain
 * this final digest as a cutover certificate, but callers must never log the
 * input lines or the individual bcrypt values used to make it.
 */
export async function passwordProofManifest(rows: readonly PasswordProofRow[]): Promise<string | null> {
  const normalised: PasswordProofRow[] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    const parsed = normalisePasswordProofRow(row);
    if (!parsed || ids.has(parsed.userId)) return null;
    ids.add(parsed.userId);
    normalised.push(parsed);
  }
  const canonical = normalised
    .sort((left, right) => left.userId.localeCompare(right.userId))
    .map((row) => [field(row.userId), field(row.sourceUpdatedAt), field(row.verifier)].join("|"))
    .join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isPasswordProofManifest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
