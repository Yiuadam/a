import { assertServerOnly } from "@/lib/auth/server-only";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { rpc } from "@/lib/auth/supabase";

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

export interface MaintenanceSetting {
  closed: boolean;
  /** When it was last changed, for the admin screen to report. */
  at?: string;
}

let cached: { value: MaintenanceSetting; until: number } | null = null;

const OPEN: MaintenanceSetting = { closed: false };

function parse(value: unknown): MaintenanceSetting {
  if (!value || typeof value !== "object") return OPEN;
  const closed = (value as { closed?: unknown }).closed === true;
  const at = (value as { at?: unknown }).at;
  return { closed, at: typeof at === "string" ? at : undefined };
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

  if (!supabaseConfigured()) return OPEN;

  try {
    const value = await rpc<unknown>("get_app_setting", { p_key: MAINTENANCE_KEY });
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
 * Opens or closes the site. Returns what is now stored.
 *
 * Throws if the write fails, and the caller reports that — this one must not
 * fail quietly, because an admin who pressed "close" and was told nothing
 * would reasonably believe the site was closed.
 */
export async function setMaintenance(
  closed: boolean,
  actorId: string | null,
): Promise<MaintenanceSetting> {
  assertServerOnly(MODULE);

  const value: MaintenanceSetting = { closed, at: new Date().toISOString() };
  const stored = await rpc<unknown>("set_app_setting", {
    p_key: MAINTENANCE_KEY,
    p_value: value,
    p_actor: actorId,
  });

  const setting = parse(stored);
  /* The cache is this isolate's; other isolates catch up within the window. */
  cached = { value: setting, until: Date.now() + CACHE_MS };
  return setting;
}

/** How long a change can take to reach every visitor, for the admin screen. */
export const MAINTENANCE_LAG_SECONDS = CACHE_MS / 1000;
