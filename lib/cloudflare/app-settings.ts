import type { AppSettingRecord } from "@/lib/auth/supabase";
import type { SessionUser } from "@/lib/auth/session";
import {
  requireBandUpCloudflareBindings,
  type BandUpCloudflareBindings,
} from "./bindings";
import { ensureCloudflareUser } from "./learner-data";

export interface CloudflareAppSettingRecord extends AppSettingRecord {
  mirroredAt: string;
}

function validateRecord(record: AppSettingRecord): void {
  if (record.key.length < 1 || record.key.length > 120 || record.key.includes("\0")) {
    throw new Error("Cloudflare app setting key is invalid");
  }
  if (!Number.isFinite(Date.parse(record.updatedAt))) {
    throw new Error("Cloudflare app setting clock is invalid");
  }
  if (record.updatedBy !== null && (record.updatedBy.length < 16 || record.updatedBy.length > 80)) {
    throw new Error("Cloudflare app setting actor is invalid");
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(canonical(value));
  if (encoded === undefined) throw new Error("Cloudflare app setting value is not JSON");
  return encoded;
}

/** Ordered, idempotent copy of one authoritative Supabase setting row. */
export async function putCloudflareAppSetting(
  record: AppSettingRecord,
  providedBindings?: BandUpCloudflareBindings,
  verifiedActor?: SessionUser | null,
): Promise<boolean> {
  validateRecord(record);
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  if (verifiedActor) {
    if (record.updatedBy !== verifiedActor.id) {
      throw new Error("Cloudflare app setting actor does not match the verified session");
    }
    await ensureCloudflareUser(verifiedActor, bindings);
  }
  const mirroredAt = new Date().toISOString();
  const result = await bindings.db.prepare(`
    INSERT INTO app_settings (
      key, value_json, source_updated_at, updated_by, mirrored_at
    ) VALUES (
      ?, ?, ?, (SELECT id FROM app_users WHERE id = ?), ?
    )
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      source_updated_at = excluded.source_updated_at,
      updated_by = excluded.updated_by,
      mirrored_at = excluded.mirrored_at
    WHERE excluded.source_updated_at >= app_settings.source_updated_at
  `).bind(
    record.key,
    canonicalJson(record.value),
    new Date(record.updatedAt).toISOString(),
    record.updatedBy,
    mirroredAt,
  ).run();
  return result.success;
}

/** D1-authoritative write after product-data cutover. */
export async function setCloudflareAppSetting(
  key: string,
  value: unknown,
  actor: SessionUser | null,
  providedBindings?: BandUpCloudflareBindings,
): Promise<AppSettingRecord> {
  const updatedAt = new Date().toISOString();
  const record = { key, value, updatedAt, updatedBy: actor?.id ?? null };
  if (!(await putCloudflareAppSetting(record, providedBindings, actor))) {
    throw new Error("Cloudflare app setting write failed");
  }
  return record;
}

export async function getCloudflareAppSetting(
  key: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<CloudflareAppSettingRecord | null> {
  if (key.length < 1 || key.length > 120 || key.includes("\0")) return null;
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const row = await bindings.db.prepare(`
    SELECT key, value_json, source_updated_at, updated_by, mirrored_at
      FROM app_settings WHERE key = ? LIMIT 1
  `).bind(key).first<{
    key: string;
    value_json: string;
    source_updated_at: string;
    updated_by: string | null;
    mirrored_at: string;
  }>();
  if (!row) return null;
  return {
    key: row.key,
    value: JSON.parse(row.value_json) as unknown,
    updatedAt: row.source_updated_at,
    updatedBy: row.updated_by,
    mirroredAt: row.mirrored_at,
  };
}

/** Remove a target-only row while Supabase is still the declared authority. */
export async function deleteCloudflareAppSettingReplica(
  key: string,
  providedBindings?: BandUpCloudflareBindings,
): Promise<boolean> {
  if (key.length < 1 || key.length > 120 || key.includes("\0")) return false;
  const bindings = providedBindings ?? await requireBandUpCloudflareBindings();
  const result = await bindings.db.prepare(
    "DELETE FROM app_settings WHERE key = ?",
  ).bind(key).run();
  return result.success;
}

export function appSettingRecordsEqual(
  source: AppSettingRecord | null,
  target: CloudflareAppSettingRecord | null,
): boolean {
  if (!source || !target) return source === null && target === null;
  return source.key === target.key
    && source.updatedAt === target.updatedAt
    && source.updatedBy === target.updatedBy
    && canonicalJson(source.value) === canonicalJson(target.value);
}
