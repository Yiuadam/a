import { assertServerOnly } from "@/lib/auth/server-only";
import {
  isPasswordProofManifest,
  passwordProofManifest,
  type PasswordProofRow,
} from "./native-password-proof";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";

const MODULE = "lib/cloudflare/native-password-migration-audit.ts";
const PAGE_SIZE = 200;
const MAX_LEGACY_ROWS = 50_000;

export type NativePasswordMigrationStatus = "verified" | "pending" | "mismatch" | "missing" | "unavailable";

export interface NativePasswordMigrationEvidence {
  status: NativePasswordMigrationStatus;
  sourceRows: number | null;
  importedRows: number | null;
  verifiedAt: string | null;
}

interface D1PasswordProofRow {
  user_id: string;
  source_updated_at: string;
  verifier: string;
}

interface StoredProofRow {
  source_rows: number;
  source_manifest_sha256: string;
  target_rows: number;
  target_manifest_sha256: string;
  verified_at: string;
}

function validCount(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= MAX_LEGACY_ROWS ? number : null;
}

function validTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

async function proofTableExists(bindings: BandUpCloudflareBindings): Promise<boolean> {
  const row = await bindings.db.prepare(`
    SELECT name FROM sqlite_master
     WHERE type = 'table' AND name = 'native_password_migration_proofs'
     LIMIT 1
  `).first<{ name: string }>();
  return row?.name === "native_password_migration_proofs";
}

async function importedRows(bindings: BandUpCloudflareBindings): Promise<PasswordProofRow[] | null> {
  const rows: PasswordProofRow[] = [];
  for (let offset = 0; offset <= MAX_LEGACY_ROWS; offset += PAGE_SIZE) {
    const page = await bindings.db.prepare(`
      SELECT user_id, source_updated_at, verifier
        FROM app_password_credentials
       WHERE migration_source = 'supabase_import'
       ORDER BY user_id
       LIMIT ? OFFSET ?
    `).bind(PAGE_SIZE, offset).all<D1PasswordProofRow>();
    if (!page.success || page.results.length > PAGE_SIZE) return null;
    rows.push(...page.results.map((row) => ({
      userId: row.user_id,
      sourceUpdatedAt: row.source_updated_at,
      verifier: row.verifier,
    })));
    if (page.results.length < PAGE_SIZE) return rows;
  }
  return null;
}

function auditFromRows(
  proof: StoredProofRow | null,
  rows: PasswordProofRow[] | null,
  manifest: string | null,
): NativePasswordMigrationEvidence {
  const imported = rows?.length ?? null;
  if (!proof) return { status: "pending", sourceRows: null, importedRows: imported, verifiedAt: null };
  const sourceRows = validCount(proof.source_rows);
  const targetRows = validCount(proof.target_rows);
  const verifiedAt = validTimestamp(proof.verified_at);
  const validProof = sourceRows !== null
    && targetRows !== null
    && verifiedAt !== null
    && isPasswordProofManifest(proof.source_manifest_sha256)
    && isPasswordProofManifest(proof.target_manifest_sha256);
  if (!validProof || imported === null || !manifest) {
    return { status: "mismatch", sourceRows, importedRows: imported, verifiedAt };
  }
  const matches = sourceRows === imported
    && targetRows === imported
    && proof.source_manifest_sha256 === manifest
    && proof.target_manifest_sha256 === manifest;
  return { status: matches ? "verified" : "mismatch", sourceRows, importedRows: imported, verifiedAt };
}

/**
 * Reads only aggregate proof state. It never returns a password verifier,
 * account id, source email or source digest to the browser.
 */
export async function nativePasswordMigrationEvidence(
  providedBindings?: BandUpCloudflareBindings,
): Promise<NativePasswordMigrationEvidence> {
  assertServerOnly(MODULE);
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  try {
    if (!(await proofTableExists(bindings))) {
      return { status: "missing", sourceRows: null, importedRows: null, verifiedAt: null };
    }
    const [proof, rows] = await Promise.all([
      bindings.db.prepare(`
        SELECT source_rows, source_manifest_sha256, target_rows, target_manifest_sha256, verified_at
          FROM native_password_migration_proofs
         WHERE singleton = 1
         LIMIT 1
      `).first<StoredProofRow>(),
      importedRows(bindings),
    ]);
    const manifest = rows ? await passwordProofManifest(rows) : null;
    return auditFromRows(proof ?? null, rows, manifest);
  } catch {
    return { status: "unavailable", sourceRows: null, importedRows: null, verifiedAt: null };
  }
}

/**
 * Writes one aggregate certificate only after the importer has copied the
 * whole confidential source export. A mismatch makes no write and keeps
 * native-only cutover blocked.
 */
export async function certifyNativePasswordMigration(
  sourceRows: unknown,
  sourceManifestSha256: unknown,
  providedBindings?: BandUpCloudflareBindings,
  now = Date.now(),
): Promise<NativePasswordMigrationEvidence> {
  assertServerOnly(MODULE);
  const expectedRows = validCount(sourceRows);
  if (expectedRows === null || !isPasswordProofManifest(sourceManifestSha256)) {
    return { status: "mismatch", sourceRows: null, importedRows: null, verifiedAt: null };
  }
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  try {
    if (!(await proofTableExists(bindings))) {
      return { status: "missing", sourceRows: expectedRows, importedRows: null, verifiedAt: null };
    }
    const rows = await importedRows(bindings);
    const manifest = rows ? await passwordProofManifest(rows) : null;
    if (!rows || !manifest || rows.length !== expectedRows || manifest !== sourceManifestSha256) {
      return { status: "mismatch", sourceRows: expectedRows, importedRows: rows?.length ?? null, verifiedAt: null };
    }
    const verifiedAt = new Date(now).toISOString();
    const result = await bindings.db.prepare(`
      INSERT INTO native_password_migration_proofs (
        singleton, source_rows, source_manifest_sha256, target_rows, target_manifest_sha256, verified_at
      ) VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        source_rows = excluded.source_rows,
        source_manifest_sha256 = excluded.source_manifest_sha256,
        target_rows = excluded.target_rows,
        target_manifest_sha256 = excluded.target_manifest_sha256,
        verified_at = excluded.verified_at
    `).bind(expectedRows, manifest, rows.length, manifest, verifiedAt).run();
    if (!result.success || (result.meta.changes ?? 0) !== 1) {
      return { status: "unavailable", sourceRows: expectedRows, importedRows: rows.length, verifiedAt: null };
    }
    return { status: "verified", sourceRows: expectedRows, importedRows: rows.length, verifiedAt };
  } catch {
    return { status: "unavailable", sourceRows: expectedRows, importedRows: null, verifiedAt: null };
  }
}
