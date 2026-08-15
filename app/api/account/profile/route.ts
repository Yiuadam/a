import { NextResponse } from "next/server";
import { accountsEnabled, isAdminEmail } from "@/lib/auth/env";
import {
  supabaseConfigured,
  signedAvatarUrl,
} from "@/lib/auth/supabase";
import { getSessionUser } from "@/lib/auth/session";
import { logInternal, safeJsonError, MESSAGES } from "@/lib/auth/errors";
import { withCors } from "@/lib/http/cors";
import { cloudflareDataMode } from "@/lib/cloudflare/bindings";
import {
  getLearnerProfile,
  getLearnerAccountKind,
  updateLearnerProfile,
  setLearnerAccountIdentity,
  claimLearnerUsername,
  learnerUsernameReplicaReady,
} from "@/lib/cloudflare/data-router";
import { cloudflareAvatarUrl } from "@/lib/cloudflare/avatar-delivery";
import { adminUsername } from "@/lib/auth/env";
import { claimable } from "@/lib/auth/usernames";
import { generateUsername, usernameFromEmailAttempt } from "@/lib/auth/generated-username";

/*
  What a learner chooses to tell us about themselves, and how they change it.

  Display name and username form the required, non-privileged account
  identity. Photo and date of birth remain optional. The legacy account-kind
  column is retained for existing data, but it is no longer user-selectable
  and grants no organization or platform authority.

  The rule that matters here is that the client names the fields it wants to
  change and the server decides which of those names are real. `role` lives in
  the same table and decides whether an account has a usage limit; a patch
  assembled from whatever arrived in the body would be a way to grant yourself
  admin. See lib/auth/supabase.ts, where the allow-list actually lives.
*/

export const dynamic = "force-dynamic";

const MAX_NAME = 60;
/* Thirteen years, matching the constraint in 0006 and the claim on /privacy. */
const MIN_AGE_YEARS = 13;

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
function cleanDate(value: unknown): string | null | undefined | "too-young" {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return undefined;
  if (t >= Date.now()) return undefined;

  /*
    The under-13 check, which /privacy has always claimed and nothing has ever
    enforced. A claim that is enforced is worth more than one that is merely
    made, and a date of birth is the only thing that makes enforcement
    possible. The same rule is a constraint in 0006, because application code
    can be bypassed by anything holding a token and a constraint cannot.
  */
  const thirteen = new Date();
  thirteen.setFullYear(thirteen.getFullYear() - MIN_AGE_YEARS);
  if (t > thirteen.getTime()) return "too-young";

  return value;
}

async function present(req: Request, user: { id: string; email: string | null }) {
  const mode = cloudflareDataMode();
  const stored = await getLearnerProfile(user);
  // A newly authenticated user may not have written application data yet.
  // In Cloudflare mode an absent D1 row is an empty optional profile, not a
  // reason to fall back to the old Supabase data authority.
  const profile = stored ?? (mode === "cloudflare" ? {
    displayName: null,
    username: null,
    accountKind: null,
    birthDate: null,
    avatarPath: null,
    email: user.email,
  } : null);
  if (!profile) return null;
  let avatarUrl: string | null = null;
  if (profile.avatarPath) {
    avatarUrl = mode === "cloudflare"
      ? await cloudflareAvatarUrl(req.url, user.id, profile.avatarPath)
      : await signedAvatarUrl(profile.avatarPath);
    if (!avatarUrl) throw new Error("avatar delivery is unavailable");
  }
  return {
    displayName: profile.displayName,
    username: profile.username,
    organizationUsernameReady: await learnerUsernameReplicaReady(user.id, profile.username),
    accountKind: profile.accountKind,
    birthDate: profile.birthDate,
    // Supabase Auth is still identity authority after application data moves.
    email: user.email ?? profile.email,
    // A fresh one-hour grant each time. The D1/R2 key itself is never a public
    // URL and the delivery route rechecks the live pointer before streaming.
    avatarUrl,
  };
}

async function handleGET(req: Request) {
  const auth = await requireUser(req);
  if (auth.error === "off") return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (auth.error === "anon") return safeJsonError(MESSAGES.signInRequired, 401);

  let body;
  try {
    body = await present(req, auth.user);
  } catch {
    body = null;
  }
  if (!body) {
    logInternal("account/profile GET", new Error("profile read failed"));
    return safeJsonError(MESSAGES.accountUnavailable, 503);
  }
  return NextResponse.json(body);
}

/*
  Which name to try next when the server is choosing one — "Do this later", an
  empty username field, or a collision on whatever came before.

  Order matters and is the whole of the owner's request: the learner's own
  email local part first, then the same with a short numeric suffix so that two
  people sharing a local part across different providers can both sign up, and
  only then the non-identifying adjective-noun generator.

  That last step is not a formality. usernameFromEmailAttempt returns null for
  an address whose local part is reserved ("admin@…"), for one that cannot be
  made into a valid handle at all, and once the suffixed attempts run out — and
  in every one of those cases a learner still needs a username. Falling through
  to the generator is what stops an unusable address becoming an account that
  cannot finish setup.
*/
function generatedCandidate(
  email: string | null | undefined,
  attempt: number,
  previous: string | null,
): string {
  return usernameFromEmailAttempt(email, attempt) ?? generateUsername(previous);
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

  if (input.deferSetup === true) {
    const supplied = typeof input.username === "string" ? input.username : "";
    const generated = input.generateUsername === true || supplied.trim().length === 0;
    let previous: string | null = null;
    for (let attempt = 0; attempt < (generated ? 10 : 1); attempt += 1) {
      const raw: string = attempt === 0 && supplied.trim()
        ? supplied
        : generatedCandidate(auth.user.email, attempt - (supplied.trim() ? 1 : 0), previous);
      const checked = claimable(raw, isAdminEmail(auth.user.email) ? null : adminUsername());
      if (!checked.ok) {
        if (generated) {
          previous = typeof raw === "string" ? raw : previous;
          continue;
        }
        return safeJsonError(
          checked.reason === "reserved"
            ? "That username is reserved. Please choose another."
            : "Use 3–30 letters, numbers, dots, dashes or underscores for your username.",
          400,
        );
      }
      previous = checked.username;
      const result = await claimLearnerUsername(auth.user, checked.username);
      if (result.status === "taken_username" && generated) continue;
      if (result.status === "taken_username") {
        return safeJsonError("That username has just been taken. Please choose another.", 409);
      }
      if (result.status !== "ok") {
        logInternal("account/profile deferred username PATCH", new Error(result.status));
        return safeJsonError(MESSAGES.accountUnavailable, 503);
      }
      if (result.cloudflareReplica === false) {
        logInternal("account/profile deferred username PATCH", new Error("Cloudflare username replication failed"));
        return safeJsonError(
          "Your username is saved, but organisation search is still syncing. Please try again.",
          503,
        );
      }
      const updated = await present(req, auth.user).catch(() => null);
      return NextResponse.json(updated ?? { username: checked.username });
    }
    return safeJsonError("We couldn't reserve a generated username. Please try again.", 503);
  }

  const fields: Record<string, string | null> = {};
  const name = cleanText(input.displayName, MAX_NAME);
  const hasIdentity = "displayName" in input || "username" in input;
  if ("birthDate" in input) {
    const date = cleanDate(input.birthDate);
    if (date === "too-young") {
      return safeJsonError(
        "BandUp is for people preparing for an English exam and isn't intended for under-13s.",
        403,
      );
    }
    if (date === undefined) {
      // The one input worth an error rather than a silent drop: a mistyped
      // date looks saved otherwise, and the learner finds out much later.
      return safeJsonError("That date doesn't look right. Use the date picker, or leave it blank.", 400);
    }
    fields.birthDate = date;
  }

  if (hasIdentity) {
    if (!name) return safeJsonError("Please enter the name we should show on your account.", 400);
    const username = typeof input.username === "string" ? input.username : "";
    const usernameCheck = claimable(username, isAdminEmail(auth.user.email) ? null : adminUsername());
    if (!usernameCheck.ok) {
      return safeJsonError(
        usernameCheck.reason === "reserved"
          ? "That username is reserved. Please choose another."
          : "Use 3–30 letters, numbers, dots, dashes or underscores for your username.",
        400,
      );
    }
    // The retired account-kind field is no longer read from the form or used
    // for behaviour. Preserve an existing legacy value; unlike the optional
    // profile presentation reader, this focused read throws when storage is
    // unavailable so a transient failure can never rewrite old data.
    let accountKind: import("@/lib/auth/account-identity").AccountKind;
    try {
      accountKind = await getLearnerAccountKind(auth.user) ?? "individual";
    } catch (error) {
      logInternal("account/profile legacy identity read", error);
      return safeJsonError(MESSAGES.accountUnavailable, 503);
    }
    const result = await setLearnerAccountIdentity(auth.user, {
      displayName: name,
      username: usernameCheck.username,
      accountKind,
      birthDate: (fields.birthDate as string | null | undefined) ?? null,
    });
    if (result.status === "taken_username") {
      return safeJsonError("That username has just been taken. Please choose another.", 409);
    }
    if (result.status !== "ok") {
      logInternal("account/profile identity PATCH", new Error(result.status));
      return safeJsonError(MESSAGES.accountUnavailable, 503);
    }
    if (result.cloudflareReplica === false) {
      logInternal("account/profile identity PATCH", new Error("Cloudflare profile replication failed"));
      return safeJsonError(
        "Your profile is saved, but organisation search is still syncing. Please try again.",
        503,
      );
    }
    const updated = await present(req, auth.user).catch(() => null);
    return NextResponse.json(updated ?? { ok: true });
  }

  if (name !== undefined) fields.displayName = name;

  if (Object.keys(fields).length === 0) {
    return safeJsonError(MESSAGES.accountUnavailable, 400);
  }

  const write = await updateLearnerProfile(auth.user, fields);
  if (!write.primary) {
    logInternal("account/profile PATCH", new Error("profile write failed"));
    return safeJsonError(MESSAGES.accountUnavailable, 503);
  }
  if (write.cloudflareReplica === false) {
    logInternal("account/profile PATCH", new Error("Cloudflare profile replication failed"));
  }
  let updated = null;
  try {
    updated = await present(req, auth.user);
  } catch {
    // The write is durable. Returning the minimal success avoids asking the
    // learner to repeat it merely because presentation failed afterwards.
  }
  return NextResponse.json(updated ?? { ok: true });
}

/*
  CORS lives on the route now rather than in proxy.ts, which cannot run on
  Cloudflare. Same behaviour, different place — see lib/http/cors.ts.
*/
export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
export const PATCH = withCors(handlePATCH);
