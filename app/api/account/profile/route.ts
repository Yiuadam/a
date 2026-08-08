import { NextResponse } from "next/server";
import { accountsEnabled } from "@/lib/auth/env";
import {
  supabaseConfigured,
  getProfile,
  updateProfile,
  signedAvatarUrl,
} from "@/lib/auth/supabase";
import { getSessionUser } from "@/lib/auth/session";
import { logInternal, safeJsonError, MESSAGES } from "@/lib/auth/errors";
import { withCors } from "@/lib/http/cors";

/*
  What a learner chooses to tell us about themselves, and how they change it.

  All of it is optional, and the route is written so that an account holding
  nothing but an id works exactly as well as a filled-in one — nothing
  downstream reads these fields to decide anything.

  The rule that matters here is that the client names the fields it wants to
  change and the server decides which of those names are real. `role` lives in
  the same table and decides whether an account has a usage limit; a patch
  assembled from whatever arrived in the body would be a way to grant yourself
  admin. See lib/auth/supabase.ts, where the allow-list actually lives.
*/

export const dynamic = "force-dynamic";

const MAX_NAME = 60;
const MAX_GENDER = 40;

async function requireUser(req: Request) {
  if (!accountsEnabled() || !supabaseConfigured()) return { error: "off" as const };
  const user = await getSessionUser(req);
  if (!user) return { error: "anon" as const };
  return { user };
}

/** Trims, collapses whitespace, and treats an empty result as "cleared". */
function cleanText(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}

/*
  A date, or nothing. Deliberately strict about the shape and lenient about
  what it means: the database already refuses a future date or one before
  1900, so this only has to reject what would make the column error.
*/
function cleanDate(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return undefined;
  if (t >= Date.now()) return undefined;
  return value;
}

async function present(userId: string) {
  const profile = await getProfile(userId);
  if (!profile) return null;
  return {
    displayName: profile.displayName,
    gender: profile.gender,
    birthDate: profile.birthDate,
    email: profile.email,
    // A fresh signed URL each time rather than a stored one, because the URL
    // expires and the path does not.
    avatarUrl: profile.avatarPath ? await signedAvatarUrl(profile.avatarPath) : null,
  };
}

async function handleGET(req: Request) {
  const auth = await requireUser(req);
  if (auth.error === "off") return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (auth.error === "anon") return safeJsonError(MESSAGES.signInRequired, 401);

  const body = await present(auth.user.id);
  if (!body) {
    logInternal("account/profile GET", new Error("profile read failed"));
    return safeJsonError(MESSAGES.accountUnavailable, 503);
  }
  return NextResponse.json(body);
}

async function handlePATCH(req: Request) {
  const auth = await requireUser(req);
  if (auth.error === "off") return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (auth.error === "anon") return safeJsonError(MESSAGES.signInRequired, 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return safeJsonError(MESSAGES.accountUnavailable, 400);
  }
  const input = (body ?? {}) as Record<string, unknown>;

  const fields: Record<string, string | null> = {};
  const name = cleanText(input.displayName, MAX_NAME);
  if (name !== undefined) fields.displayName = name;
  const gender = cleanText(input.gender, MAX_GENDER);
  if (gender !== undefined) fields.gender = gender;

  if ("birthDate" in input) {
    const date = cleanDate(input.birthDate);
    if (date === undefined) {
      // The one input worth an error rather than a silent drop: a mistyped
      // date looks saved otherwise, and the learner finds out much later.
      return safeJsonError("That date doesn't look right. Use the date picker, or leave it blank.", 400);
    }
    fields.birthDate = date;
  }

  if (Object.keys(fields).length === 0) {
    return safeJsonError(MESSAGES.accountUnavailable, 400);
  }

  if (!(await updateProfile(auth.user.id, fields))) {
    logInternal("account/profile PATCH", new Error("profile write failed"));
    return safeJsonError(MESSAGES.accountUnavailable, 503);
  }

  const updated = await present(auth.user.id);
  return NextResponse.json(updated ?? { ok: true });
}

/*
  CORS lives on the route now rather than in proxy.ts, which cannot run on
  Cloudflare. Same behaviour, different place — see lib/http/cors.ts.
*/
export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
export const PATCH = withCors(handlePATCH);
