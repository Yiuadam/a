import {
  getAppSettingRecord,
  type AppSettingRecord,
} from "@/lib/auth/supabase";
import { cloudflareDataMode, type BandUpCloudflareBindings, type CloudflareDataMode } from "./bindings";
import {
  appSettingRecordsEqual,
  deleteCloudflareAppSettingReplica,
  getCloudflareAppSetting,
  putCloudflareAppSetting,
  type CloudflareAppSettingRecord,
} from "./app-settings";

export const CUTOVER_APP_SETTING_KEYS = [
  "maintenance",
  "maintenance_dispatch",
] as const;

export type AppSettingParityStatus =
  | "equal"
  | "absent"
  | "source_only"
  | "target_only"
  | "different"
  | "unavailable";

export interface AppSettingParityItem {
  key: string;
  status: AppSettingParityStatus;
  sourceUpdatedAt: string | null;
  targetUpdatedAt: string | null;
}

export interface AppSettingsParityReport {
  generatedAt: string;
  authority: "supabase" | "cloudflare";
  /*
    Reported as the full four-state CloudflareDataMode, not narrowed to three,
    even though app settings themselves only ever branch on exactly
    "cloudflare"/"dual" (lib/admin/settings.ts — out of scope for this stage).
    A report that quietly collapsed "read_cloudflare" into "dual" would be
    lying about which mode is actually configured.
  */
  mode: CloudflareDataMode;
  readyForAppSettingsCutover: boolean;
  items: AppSettingParityItem[];
}

type SourceReader = (key: string) => Promise<AppSettingRecord | null>;

function statusFor(
  source: AppSettingRecord | null,
  target: CloudflareAppSettingRecord | null,
): AppSettingParityStatus {
  if (!source && !target) return "absent";
  if (source && !target) return "source_only";
  if (!source && target) return "target_only";
  return appSettingRecordsEqual(source, target) ? "equal" : "different";
}

/**
 * Exact per-key value, source-clock and actor parity. Unlike aggregate counts,
 * this is strong enough to prove this bounded settings domain has converged.
 */
export async function appSettingsParityReport(
  providedBindings?: BandUpCloudflareBindings,
  readSource: SourceReader = getAppSettingRecord,
): Promise<AppSettingsParityReport> {
  const mode = cloudflareDataMode();
  const items = await Promise.all(CUTOVER_APP_SETTING_KEYS.map(async (key) => {
    const [source, target] = await Promise.allSettled([
      readSource(key),
      getCloudflareAppSetting(key, providedBindings),
    ]);
    if (source.status === "rejected" || target.status === "rejected") {
      return {
        key,
        status: "unavailable" as const,
        sourceUpdatedAt: null,
        targetUpdatedAt: null,
      };
    }
    return {
      key,
      status: statusFor(source.value, target.value),
      sourceUpdatedAt: source.value?.updatedAt ?? null,
      targetUpdatedAt: target.value?.updatedAt ?? null,
    };
  }));
  return {
    generatedAt: new Date().toISOString(),
    authority: mode === "cloudflare" ? "cloudflare" : "supabase",
    mode,
    readyForAppSettingsCutover: items.every(
      (item) => item.status === "equal" || item.status === "absent",
    ),
    items,
  };
}

/**
 * Explicit owner-triggered repair. It is deliberately unavailable after the
 * authority switch, when copying the retired source forwards would be unsafe.
 */
export async function reconcileAppSettingsReplica(
  providedBindings?: BandUpCloudflareBindings,
  readSource: SourceReader = getAppSettingRecord,
): Promise<AppSettingsParityReport> {
  if (cloudflareDataMode() !== "dual") {
    throw new Error("App settings reconciliation is available only in dual mode");
  }
  for (const key of CUTOVER_APP_SETTING_KEYS) {
    const source = await readSource(key);
    const success = source
      ? await putCloudflareAppSetting(source, providedBindings)
      : await deleteCloudflareAppSettingReplica(key, providedBindings);
    if (!success) throw new Error(`App setting ${key} could not be reconciled`);
  }
  return appSettingsParityReport(providedBindings, readSource);
}
