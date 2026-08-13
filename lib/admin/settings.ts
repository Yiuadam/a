import { assertServerOnly } from "@/lib/auth/server-only";
import type { SessionUser } from "@/lib/auth/session";
import {
  getAppSettingRecord,
  rpc,
  supabaseConfigured,
} from "@/lib/auth/supabase";
import { logInternal } from "@/lib/auth/errors";
import { cloudflareDataMode } from "@/lib/cloudflare/bindings";
import {
  getCloudflareAppSetting,
  putCloudflareAppSetting,
  setCloudflareAppSetting,
} from "@/lib/cloudflare/app-settings";

const MODULE = "lib/admin/settings.ts";

/*
  Settings the owner can change while the site is running.

  ---------------------------------------------------------------------------
  Every failure here leaves the site open

  A settings read happens on the way to drawing a page, so it can fail in all
  the ordinary ways: the database is unreachable, the migration has not been
  applied, the key has never been written. Each of those returns "not in
  maintenance", and that direction is the whole safety property. A shelf that
  could close a live site by being empty, or by timing out, would be a worse
  failure than the manual switch it replaced — and it would fail at exactly the
  moment the database is already having a bad day.

  Closing the site is therefore only ever the result of somebody deciding to.

  ---------------------------------------------------------------------------
  Cached for a few seconds, deliberately

  Without a cache this is a database round trip in front of every page render,
  which is a real cost paid on every request forever to support a switch thrown
  a handful of times a year. With one, the cost is paid once per window per
  Worker isolate and the switch takes up to that long to take effect.

  Ten seconds is the trade: short enough that "close the site" feels immediate
  to somebody watching, long enough that the read disappears from the latency
  of a normal page. The admin screen says so rather than letting somebody
  wonder why their click has not landed yet.
*/

const CACHE_MS = 10_000;

export const MAINTENANCE_KEY = "maintenance";
export const MAINTENANCE_DISPATCH_KEY = "maintenance_dispatch";

export interface MaintenanceSetting {
  closed: boolean;
  /** When it was last changed, for the admin screen to report. */
  at?: string;
}

/** The last GitHub dispatch result, stored separately from the owner's choice. */
export interface MaintenanceDispatchSetting {
  closed: boolean;
  decisionAt: string;
  started: boolean;
  problem: string | null;
  attemptedAt: string;
}

let cached: { value: MaintenanceSetting; until: number } | null = null;

const OPEN: MaintenanceSetting = { closed: false };

async function readSetting(key: string): Promise<unknown> {
  const mode = cloudflareDataMode();
  if (mode === "cloudflare") {
    return (await getCloudflareAppSetting(key))?.value ?? null;
  }
  if (!supabaseConfigured()) return null;

  const record = await getAppSettingRecord(key);
  if (mode === "dual" && record) {
    try {
      if (!(await putCloudflareAppSetting(record))) {
        throw new Error("Cloudflare app setting replica was not stored");
      }
    } catch (error) {
      // Supabase remains the read authority in dual mode. Report drift, but a
      // replica outage must not change the running site's current setting.
      logInternal(`admin/settings:${key}:cloudflare-read-repair`, error);
    }
  }
  return record?.value ?? null;
}

async function writeSetting(
  key: string,
  value: unknown,
  actor: SessionUser | null,
): Promise<unknown> {
  const mode = cloudflareDataMode();
  if (mode === "cloudflare") {
    return (await setCloudflareAppSetting(key, value, actor)).value;
  }

  const stored = await rpc<unknown>("set_app_setting", {
    p_key: key,
    p_value: value,
    p_actor: actor?.id ?? null,
  });
  if (mode !== "dual") return stored;

  try {
    // Re-read the committed row so D1 receives Postgres's exact timestamp and
    // the winning value if two owner actions raced one another.
    const record = await getAppSettingRecord(key);
    if (!record || !(await putCloudflareAppSetting(record, undefined, actor))) {
      throw new Error("Cloudflare app setting replica was not stored");
    }
  } catch (error) {
    // The source write already committed. Preserve that success and surface
    // the independently repairable replica drift in server logs/readiness.
    logInternal(`admin/settings:${key}:cloudflare-write`, error);
  }
  return stored;
}

function parse(value: unknown): MaintenanceSetting {
  if (!value || typeof value !== "object") return OPEN;
  const closed = (value as { closed?: unknown }).closed === true;
  const at = (value as { at?: unknown }).at;
  return { closed, at: typeof at === "string" ? at : undefined };
}

function parseDispatch(value: unknown): MaintenanceDispatchSetting | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.closed !== "boolean" ||
    typeof row.decisionAt !== "string" ||
    typeof row.started !== "boolean" ||
    (row.problem !== null && typeof row.problem !== "string") ||
    typeof row.attemptedAt !== "string"
  ) {
    return null;
  }
  return {
    closed: row.closed,
    decisionAt: row.decisionAt,
    started: row.started,
    problem: row.problem,
    attemptedAt: row.attemptedAt,
  };
}

/**
 * Whether the owner has closed the site, as of at most `CACHE_MS` ago.
 *
 * Never throws. See the note above on why every failure means "open".
 */
export async function maintenanceSetting(): Promise<MaintenanceSetting> {
  assertServerOnly(MODULE);

  const now = Date.now();
  if (cached && cached.until > now) return cached.value;

  try {
    const value = await readSetting(MAINTENANCE_KEY);
    const setting = parse(value);
    cached = { value: setting, until: now + CACHE_MS };
    return setting;
  } catch {
    /*
      Unreachable, or the migration has not been applied and PostgREST answers
      404 for a function it has never seen. Both mean the owner has not closed
      the site, because closing it is something only a successful write can do.

      Cached like a success, so a database that is down does not turn every
      page render into a doomed round trip with an eight-second timeout on it.
    */
    cached = { value: OPEN, until: now + CACHE_MS };
    return OPEN;
  }
}

/**
 * The outcome of the dispatch for the current choice, if one was recorded.
 *
 * This lives under its own JSON setting key so recording an API outcome can
 * never overwrite a newer open/closed choice. The existing jsonb settings
 * shelf needs no schema change for the extra key.
 */
export async function maintenanceDispatchSetting(): Promise<MaintenanceDispatchSetting | null> {
  assertServerOnly(MODULE);

  try {
    const value = await readSetting(MAINTENANCE_DISPATCH_KEY);
    return parseDispatch(value);
  } catch {
    return null;
  }
}

/**
 * Opens or closes the site. Returns what is now stored.
 *
 * Throws if the write fails, and the caller reports that — this one must not
 * fail quietly, because an admin who pressed "close" and was told nothing
 * would reasonably believe the site was closed.
 */
export async function setMaintenance(
  closed: boolean,
  actor: SessionUser | null,
): Promise<MaintenanceSetting> {
  assertServerOnly(MODULE);

  const value: MaintenanceSetting = { closed, at: new Date().toISOString() };
  const stored = await writeSetting(MAINTENANCE_KEY, value, actor);

  const setting = parse(stored);
  /* The cache is this isolate's; other isolates catch up within the window. */
  cached = { value: setting, until: Date.now() + CACHE_MS };
  return setting;
}

/** Persist whether GitHub accepted the deploy request, for reloads/new tabs. */
export async function recordMaintenanceDispatch(
  result: Omit<MaintenanceDispatchSetting, "attemptedAt">,
  actor: SessionUser | null,
): Promise<MaintenanceDispatchSetting> {
  assertServerOnly(MODULE);

  const value: MaintenanceDispatchSetting = {
    ...result,
    attemptedAt: new Date().toISOString(),
  };
  const stored = await writeSetting(MAINTENANCE_DISPATCH_KEY, value, actor);

  const parsed = parseDispatch(stored);
  if (!parsed) throw new Error("The maintenance dispatch result was not stored correctly.");
  return parsed;
}

/** How long a change can take to reach every visitor, for the admin screen. */
export const MAINTENANCE_LAG_SECONDS = CACHE_MS / 1000;
