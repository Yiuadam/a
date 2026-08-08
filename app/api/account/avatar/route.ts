import { NextResponse } from "next/server";
import { accountsEnabled } from "@/lib/auth/env";
import {
  supabaseConfigured,
  getProfile,
  updateProfile,
  uploadAvatar,
  deleteAvatar,
  signedAvatarUrl,
} from "@/lib/auth/supabase";
import { getSessionUser } from "@/lib/auth/session";
import { logInternal, safeJsonError, MESSAGES } from "@/lib/auth/errors";
import { withCors } from "@/lib/http/cors";

/*
  Uploading and removing a profile picture.

  An upload endpoint is the most abusable thing in this app — it is the only
  route that writes a file — so the checks are deliberately boring and all of
  them happen before anything is stored.

  The file type is decided by reading the first bytes, not by trusting the
  Content-Type header or the filename. Both of those are written by the caller;
  the magic number is written by whatever actually produced the image. A .png
  that is really a script is a real thing people upload, and the bucket is
  configured to accept three image types precisely so the answer to "what could
  this file be" stays short.

  The path is built from the session user's id and never from anything in the
  request, so there is no filename a caller can send that reaches another
  learner's folder.

  ---------------------------------------------------------------------------
  Why the size limit did not move when the app started accepting 10 MB photos

  The account screen now lets a learner pick a picture of any resolution up to
  ten megabytes. Nothing here changed to allow that, and nothing here should
  have: components/account/condense.ts crops and re-encodes the picture in the
  browser first, so what arrives is a 512-pixel JPEG of perhaps sixty
  kilobytes. The learner's ceiling and this route's ceiling are answers to
  different questions — theirs is "what may I choose", which should be
  generous, and this one is "how much may an authenticated caller push into
  storage per request", which should not be.

  Raising this to ten would multiply the cost of the cheapest abuse there is by
  five and buy nobody anything, since no legitimate upload from this app comes
  close to two. It would also put the route above the bucket, whose
  file_size_limit is two megabytes (0005_profile_fields.sql) — and a request
  accepted here and refused by storage fails later, less clearly, and after the
  bytes have already crossed the network.
*/

export const dynamic = "force-dynamic";

/*
  Two megabytes, matching the bucket. Every real upload is a small fraction of
  it; anything near it did not come from this app's own screen.
*/
const MAX_BYTES = 2 * 1024 * 1024;

/*
  Magic numbers for the three types the bucket accepts. A file is what its
  first bytes say it is.
*/
const SIGNATURES: { ext: string; mime: string; test: (b: Uint8Array) => boolean }[] = [
  {
    ext: "jpg",
    mime: "image/jpeg",
    test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    ext: "png",
    mime: "image/png",
    test: (b) =>
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    ext: "webp",
    mime: "image/webp",
    // "RIFF" .... "WEBP"
    test: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

function identify(bytes: Uint8Array) {
  return SIGNATURES.find((s) => s.test(bytes)) ?? null;
}

async function requireUser(req: Request) {
  if (!accountsEnabled() || !supabaseConfigured()) return { error: "off" as const };
  const user = await getSessionUser(req);
  if (!user) return { error: "anon" as const };
  return { user };
}

async function handlePOST(req: Request) {
  const auth = await requireUser(req);
  if (auth.error === "off") return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (auth.error === "anon") return safeJsonError(MESSAGES.signInRequired, 401);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return safeJsonError(MESSAGES.accountUnavailable, 400);
  }

  const file = form.get("avatar");
  if (!(file instanceof File)) {
    return safeJsonError("No picture was received. Please choose a file and try again.", 400);
  }
  if (file.size === 0) {
    return safeJsonError("That file is empty. Please choose another.", 400);
  }
  if (file.size > MAX_BYTES) {
    /*
      A learner using the app should never see this, because the browser has
      already shrunk the picture by the time it is sent. When it does appear,
      something went wrong on the way rather than the photo being unsuitable —
      so the sentence says to try again rather than telling someone to go and
      find a smaller picture they do not need.
    */
    return safeJsonError("That picture didn't arrive in one piece. Please try again.", 413);
  }

  const buffer = await file.arrayBuffer();
  const kind = identify(new Uint8Array(buffer.slice(0, 16)));
  if (!kind) {
    return safeJsonError("That doesn't look like a JPEG, PNG or WebP image.", 415);
  }

  /*
    A random segment in the path, even though the folder is already the user's
    id. Without it the URL of a picture is derivable from an account id, and
    replacing a picture would reuse the same path — so an old signed link would
    keep resolving to the new image.
  */
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const path = `${auth.user.id}/${suffix}.${kind.ext}`;

  if (!(await uploadAvatar(path, buffer, kind.mime))) {
    logInternal("account/avatar POST", new Error("upload failed"));
    return safeJsonError(MESSAGES.accountUnavailable, 503);
  }

  const previous = await getProfile(auth.user.id);
  if (!(await updateProfile(auth.user.id, { avatarPath: path }))) {
    logInternal("account/avatar POST", new Error("profile not updated after upload"));
    return safeJsonError(MESSAGES.accountUnavailable, 503);
  }

  /*
    The old file goes only after the new one is stored and pointed at. The
    other order risks deleting a picture and then failing to replace it, which
    loses something the learner cannot get back from us.
  */
  if (previous?.avatarPath && previous.avatarPath !== path) {
    void deleteAvatar(previous.avatarPath);
  }

  return NextResponse.json({ avatarUrl: await signedAvatarUrl(path) });
}

async function handleDELETE(req: Request) {
  const auth = await requireUser(req);
  if (auth.error === "off") return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (auth.error === "anon") return safeJsonError(MESSAGES.signInRequired, 401);

  const profile = await getProfile(auth.user.id);
  if (!(await updateProfile(auth.user.id, { avatarPath: null }))) {
    logInternal("account/avatar DELETE", new Error("profile not cleared"));
    return safeJsonError(MESSAGES.accountUnavailable, 503);
  }
  if (profile?.avatarPath) void deleteAvatar(profile.avatarPath);

  return NextResponse.json({ avatarUrl: null });
}

/*
  CORS lives on the route now rather than in proxy.ts, which cannot run on
  Cloudflare. Same behaviour, different place — see lib/http/cors.ts.
*/
export { OPTIONS } from "@/lib/http/cors";
export const POST = withCors(handlePOST);
export const DELETE = withCors(handleDELETE);
