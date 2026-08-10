import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { accountsEnabled, isAdminEmail } from "@/lib/auth/env";
import { supabaseConfigured } from "@/lib/auth/supabase";
import {
  MAINTENANCE_LAG_SECONDS,
  maintenanceSetting,
  setMaintenance,
} from "@/lib/admin/settings";
import { MAINTENANCE_MODE } from "@/lib/maintenance";
import { withCors } from "@/lib/http/cors";
import { logInternal, safeJsonError } from "@/lib/auth/errors";

/*
  The switch that closes the site, and the only way to throw it from a browser.

  ---------------------------------------------------------------------------
  Why this route is not gated by the maintenance screen it controls

  Because it is an API route, and the gate replaces pages rather than routes.
  That is what makes the switch reversible: with the site closed, /admin will
  not render — it is a page — but this endpoint still answers, so the site can
  always be reopened. A switch that could lock the owner away from itself would
  be worse than no switch.

  The admin screen is served open, so in practice the owner never meets that
  edge. It is written down because somebody will one day wonder why the gate
  does not cover /api, and the answer is deliberate.
*/

export const dynamic = "force-dynamic";

/**
 * 404 for anyone who is not the owner, matching the diagnostics route.
 *
 * A 403 confirms the route exists and is worth attacking; a 404 says nothing.
 * This one closes a live website, so it is the last route in the app that
 * should be advertising itself.
 */
async function requireOwner(req: Request) {
  if (!accountsEnabled() || !supabaseConfigured()) return null;
  const user = await getSessionUser(req).catch(() => null);
  if (!user || !isAdminEmail(user.email)) return null;
  return user;
}

const notFound = () => NextResponse.json({ error: "Not found." }, { status: 404 });

async function handleGET(req: Request) {
  const user = await requireOwner(req);
  if (!user) return notFound();

  const setting = await maintenanceSetting();
  return NextResponse.json({
    closed: setting.closed,
    changedAt: setting.at ?? null,
    /*
      Reported separately, because the two switches fail differently and an
      owner staring at a closed site needs to know which one is holding it.
      A build-time close cannot be undone from this screen — it takes a deploy
      — and saying so is kinder than a button that appears to do nothing.
    */
    closedByDeploy: MAINTENANCE_MODE,
    lagSeconds: MAINTENANCE_LAG_SECONDS,
  });
}

async function handlePOST(req: Request) {
  const user = await requireOwner(req);
  if (!user) return notFound();

  let body: { closed?: unknown };
  try {
    body = await req.json();
  } catch {
    return safeJsonError("Invalid request body.", 400);
  }
  if (typeof body.closed !== "boolean") {
    return safeJsonError("Send { closed: true } or { closed: false }.", 400);
  }

  try {
    const setting = await setMaintenance(body.closed, user.id);
    return NextResponse.json({
      closed: setting.closed,
      changedAt: setting.at ?? null,
      closedByDeploy: MAINTENANCE_MODE,
      lagSeconds: MAINTENANCE_LAG_SECONDS,
    });
  } catch (err) {
    /*
      Loudly, not quietly. An owner who pressed "close the site" and got a
      shrug would reasonably believe it had worked, and would walk away from a
      site that is still open.
    */
    logInternal("admin/maintenance", err);
    return safeJsonError(
      "That didn't save. The site is unchanged — check the database is reachable and try again.",
      503,
    );
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
export const POST = withCors(handlePOST);
