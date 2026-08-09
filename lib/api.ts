import { accessToken, clearAccess, saveAccess } from "./access";

/*
  On the web the app and its API share an origin, so a relative path is right.
  Inside the iOS app the UI is served from the bundle (capacitor://) and has no
  server of its own, so requests must go to the deployed API instead. The base
  URL is baked in at build time by scripts/build-mobile.mjs.
*/
const BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/$/, "");

export function apiUrl(path: string): string {
  return `${BASE}${path}`;
}

/**
 * The API said this needs a subscription.
 *
 * A subclass rather than a flag so the existing `err instanceof Error`
 * handling in every caller keeps working unchanged, while a caller that wants
 * to offer the upgrade can ask for this specifically.
 */
export class PaywallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaywallError";
  }
}

interface ApiError {
  error?: unknown;
  code?: unknown;
}

function messageOf(payload: unknown, fallback: string): string {
  return payload && typeof payload === "object" && "error" in payload
    ? String((payload as ApiError).error)
    : fallback;
}

async function send(path: string, body: unknown, token: string | null): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    return await fetch(apiUrl(path), { method: "POST", headers, body: JSON.stringify(body) });
  } catch {
    throw new Error("Couldn't reach the server. Check your connection and try again.");
  }
}

/**
 * Trade an expired token for a fresh one.
 *
 * Deliberately a bare fetch rather than a `postJSON` call: this is the one
 * request that must not itself try to refresh, or a lapsed subscription would
 * recurse until the stack ran out.
 */
async function renew(token: string): Promise<string | null> {
  let res: Response;
  try {
    res = await send("/api/billing/refresh", { token }, null);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const data = (await res.json()) as { token?: string; expiresIn?: number };
    if (!data.token) return null;
    saveAccess(data.token, data.expiresIn ?? 0);
    return data.token;
  } catch {
    return null;
  }
}

/** POST JSON and surface the API's error message rather than a bare status. */
export async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const token = accessToken();
  let res = await send(path, body, token);

  // Tokens are short-lived by design, so an expiry mid-session is the normal
  // case and not something a learner should ever be shown.
  if (res.status === 402 && token) {
    let code: unknown;
    try {
      code = ((await res.clone().json()) as ApiError).code;
    } catch {
      code = undefined;
    }
    if (code === "token-expired") {
      const fresh = await renew(token);
      if (fresh) res = await send(path, body, fresh);
      else clearAccess();
    } else if (code === "payment-required") {
      // The token verified but no longer entitles anything — a cancellation,
      // or a seat whose invoice was voided. Stop presenting the app as paid.
      clearAccess();
    }
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new Error("The server returned an unexpected response. Please try again.");
  }

  if (!res.ok) {
    if (res.status === 402) {
      throw new PaywallError(messageOf(payload, "This feature is part of BandUp Plus."));
    }
    throw new Error(messageOf(payload, "Something went wrong. Please try again."));
  }
  return payload as T;
}
