import { NextResponse } from "next/server";
import { accountsEnabled } from "@/lib/auth/env";
import {
  supabaseConfigured,
  getProgressSnapshots,
  putProgressSnapshot,
  isProgressKey,
} from "@/lib/auth/supabase";
import { getSessionUser } from "@/lib/auth/session";
import { logInternal, safeJsonError, MESSAGES } from "@/lib/auth/errors";
import { withCors } from "@/lib/http/cors";

/*
  Reading and writing a signed-in learner's synced progress.

  Two rules shape this route, both from ACCOUNTS.md threat 5.

  It is signed-in only, with no anonymous fallback. Everywhere else in this
  system anonymous is an ordinary state to handle gracefully; here there is
  nothing to read and nowhere to write, and pretending otherwise would mean
  inventing an identity for someone who has not got one.

  And the merge happens on the client, not here. That looks like the wrong
  place for it — the server is the trustworthy party — but the client is the
  only party that can see the browser's localStorage, and the merge is between
  that and the account. What the server does is store what it is given, which
  is why lib/progress/sync.ts must read before it writes and never the other
  way round.
*/

export const dynamic = "force-dynamic";

const MAX_BYTES = 512 * 1024;

async function requireUser(req: Request) {
  if (!accountsEnabled() || !supabaseConfigured()) return { error: "off" as const };
  const user = await getSessionUser(req);
  if (!user) return { error: "anon" as const };
  return { user };
}

async function handleGET(req: Request) {
  const auth = await requireUser(req);
  if (auth.error === "off") return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (auth.error === "anon") return safeJsonError(MESSAGES.signInRequired, 401);

  const rows = await getProgressSnapshots(auth.user.id);
  if (rows === null) {
    logInternal("account/progress GET", new Error("snapshot read failed"));
    return safeJsonError(MESSAGES.accountUnavailable, 503);
  }

  return NextResponse.json({
    snapshots: rows.map((r) => ({
      storeKey: r.storeKey,
      payload: r.payload,
      clientUpdatedAt: r.clientUpdatedAt,
    })),
  });
}

async function handlePUT(req: Request) {
  const auth = await requireUser(req);
  if (auth.error === "off") return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (auth.error === "anon") return safeJsonError(MESSAGES.signInRequired, 401);

  const raw = await req.text();
  /*
    A cap, because this is the one route a client can post arbitrary JSON to.
    Half a megabyte is far more than three localStorage keys will ever hold and
    far less than enough to be worth using as storage for something else.
  */
  if (raw.length > MAX_BYTES) {
    return safeJsonError("That's more progress than we can store. Please contact support.", 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return safeJsonError(MESSAGES.accountUnavailable, 400);
  }

  const snapshots = (body as { snapshots?: unknown })?.snapshots;
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    return safeJsonError(MESSAGES.accountUnavailable, 400);
  }

  const stamp = new Date().toISOString();
  let written = 0;

  for (const entry of snapshots) {
    const { storeKey, payload } = (entry ?? {}) as { storeKey?: unknown; payload?: unknown };
    // An unknown key is skipped rather than failing the request: one bad entry
    // must not cost the learner the other two.
    if (!isProgressKey(storeKey) || payload === undefined) continue;
    if (await putProgressSnapshot(auth.user.id, storeKey, payload, stamp)) written += 1;
  }

  if (written === 0) {
    logInternal("account/progress PUT", new Error("no snapshot written"));
    return safeJsonError(MESSAGES.accountUnavailable, 503);
  }

  return NextResponse.json({ written, at: stamp });
}

/*
  CORS lives on the route now rather than in proxy.ts, which cannot run on
  Cloudflare. Same behaviour, different place — see lib/http/cors.ts.
*/
export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
export const PUT = withCors(handlePUT);
