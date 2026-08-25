"use client";

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
  if (path.startsWith("/organization/invite?")) return safeOrganizationInvitePath(path);
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return false;
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  return true;
}

function safeOrganizationInvitePath(path: string): boolean {
  if (path.startsWith("//") || path.includes("\\")) return false;
  try {
    const parsed = new URL(path, "https://bandup.life");
    const token = parsed.hash.startsWith("#token=")
      ? new URLSearchParams(parsed.hash.slice(1)).get("token")
      : null;
    return parsed.origin === "https://bandup.life"
      && parsed.pathname === "/organization/invite"
      && /^[0-9a-f-]{36}$/i.test(parsed.searchParams.get("request") ?? "")
      && (parsed.hash === "" || Boolean(token && token.length >= 24));
  } catch {
    return false;
  }
}
