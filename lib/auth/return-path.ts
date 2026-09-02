"use client";

import { routePath } from "@/lib/platform";

const KEY = "bandup.auth.return.v1";

/**
 * Preserve one in-app destination across a full OAuth navigation.
 *
 * Used to be one path only — the organization invitation link — because
 * that was the only place sign-in interrupted an action a person was
 * already mid-way through. Every "Sign in to do X" prompt in the app sends
 * a visitor to /account the same way, and every one of them deserves the
 * same courtesy: land back where the button was clicked, not on a generic
 * account page they now have to navigate away from a second time. See
 * components/account/SignInLink.tsx, the one place that calls this.
 *
 * Only a same-origin relative path is ever accepted, so this can never
 * become an open redirect even if storage is modified manually — no
 * scheme, no protocol-relative "//", no backslash a browser could still
 * treat as a host separator.
 *
 * The path is stored exactly as it was handed over, trailing slash and all.
 * That is deliberate and it is the opposite of what the comparisons below
 * do: inside the iOS app "/organization/invite/" is the form that resolves,
 * because the static export serves a directory's index.html, so normalising
 * a *destination* would be trimming it into a path that build cannot open.
 * Only the checks are normalised — see routePath in lib/platform.ts.
 */
export function rememberAuthReturnPath(path: string): boolean {
  if (!safeAuthReturnPath(path) || typeof window === "undefined") return false;
  try {
    window.sessionStorage.setItem(KEY, path);
    return true;
  } catch {
    return false;
  }
}

export function consumeAuthReturnPath(fallback = "/account/"): string {
  if (typeof window === "undefined") return fallback;
  try {
    const path = window.sessionStorage.getItem(KEY);
    window.sessionStorage.removeItem(KEY);
    return path && safeAuthReturnPath(path) ? path : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The organization invitation link keeps its own stricter check — it must
 * still carry a real request id and, if present, a token long enough to be
 * genuine — since a lost token there loses access to a real invitation.
 * Every other in-app path only has to be genuinely in-app: one leading
 * slash, never two (protocol-relative), no backslash a browser could still
 * read as a host separator, and no scheme before the path.
 */
export function safeAuthReturnPath(path: string): boolean {
  if (isOrganizationInvitePath(path)) return safeOrganizationInvitePath(path);
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return false;
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  return true;
}

/*
  Which paths take the stricter check, whichever form of the route this build
  produces.

  It used to be `startsWith("/organization/invite?")`, and inside the iOS app
  that is never true: the export's trailing slash makes the invitation
  "/organization/invite/?request=…", so the app's own invitations were being
  waved through as ordinary in-app paths and the check that the request id and
  token are real never ran on the one platform. Comparing the route rather than
  the leading characters of the whole path is what makes the two builds agree.
  The query mark still has to be there — a bare /organization/invite carries no
  invitation to protect and stays an ordinary path, as it was before.
*/
function isOrganizationInvitePath(path: string): boolean {
  const query = path.indexOf("?");
  return query >= 0 && routePath(path.slice(0, query)) === "/organization/invite";
}

function safeOrganizationInvitePath(path: string): boolean {
  if (path.startsWith("//") || path.includes("\\")) return false;
  try {
    const parsed = new URL(path, "https://bandup.life");
    const token = parsed.hash.startsWith("#token=")
      ? new URLSearchParams(parsed.hash.slice(1)).get("token")
      : null;
    return parsed.origin === "https://bandup.life"
      && routePath(parsed.pathname) === "/organization/invite"
      && /^[0-9a-f-]{36}$/i.test(parsed.searchParams.get("request") ?? "")
      && (parsed.hash === "" || Boolean(token && token.length >= 24));
  } catch {
    return false;
  }
}
