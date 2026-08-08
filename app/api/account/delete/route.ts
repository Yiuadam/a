import { NextResponse } from "next/server";
import { accountsEnabled } from "@/lib/auth/env";
import { supabaseConfigured, getProfile, deleteAccount } from "@/lib/auth/supabase";
import { getSessionUser } from "@/lib/auth/session";
import { logInternal, safeJsonError, MESSAGES } from "@/lib/auth/errors";
import { withCors } from "@/lib/http/cors";

/*
  Closing an account.

  Apple's guideline 5.1.1(v) requires that an app offering account creation
  also offers account deletion from inside the app. It is a common rejection,
  and it is also the right behaviour: an account someone can create but not
  close is a one-way door.

  This deletes the account and everything the database holds against it. What
  it deliberately does not touch is the copy of their practice in their own
  browser — that is theirs, it never belonged to us, and clearing it is
  something they can do from their own browser settings whenever they choose.
  The UI says so before the button is pressed.
*/

export const dynamic = "force-dynamic";

async function handlePOST(req: Request) {
  if (!accountsEnabled() || !supabaseConfigured()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const user = await getSessionUser(req);
  if (!user) return safeJsonError(MESSAGES.signInRequired, 401);

  /*
    A typed confirmation rather than a second button. Deletion cannot be
    undone, and the request is one fetch away from anything else on the page,
    so the intent has to be unambiguous at the point it arrives here rather
    than only in the interface.
  */
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  if ((body as { confirm?: unknown } | null)?.confirm !== "DELETE") {
    return safeJsonError("Type DELETE to confirm.", 400);
  }

  const profile = await getProfile(user.id);
  if (!(await deleteAccount(user.id, profile?.avatarPath ?? null))) {
    logInternal("account/delete", new Error("account deletion failed"));
    return safeJsonError(MESSAGES.accountUnavailable, 503);
  }

  return NextResponse.json({ deleted: true });
}

/*
  CORS lives on the route now rather than in proxy.ts, which cannot run on
  Cloudflare. Same behaviour, different place — see lib/http/cors.ts.
*/
export { OPTIONS } from "@/lib/http/cors";
export const POST = withCors(handlePOST);
