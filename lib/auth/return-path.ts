"use client";

const KEY = "bandup.auth.return.v1";

/**
 * Preserve one in-app destination across a full OAuth navigation. Only a
 * relative organization invitation path is accepted, so this can never
 * become an open redirect even if storage is modified manually.
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

export function safeAuthReturnPath(path: string): boolean {
  if (!path.startsWith("/organization/invite?")) return false;
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
