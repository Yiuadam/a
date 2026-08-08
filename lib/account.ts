"use client";

/*
  The signed-in session, as the browser holds it.

  Phase 1 settled the scheme: a bearer token in an Authorization header, never
  a cookie, because the iOS build is a static bundle on capacitor://localhost
  calling an API on another origin, and a cross-site cookie is simply not sent
  there (ACCOUNTS.md, threat 6). That decision is what this file implements.

  ---------------------------------------------------------------------------
  Why localStorage, said plainly

  A token in localStorage is readable by any script that runs on this origin.
  The honest framing is not "localStorage is unsafe and cookies are safe" — an
  httpOnly cookie would genuinely be out of reach of script, but it is the
  thing iOS will not send, and a token this app cannot use on the platform it
  is being built for protects nobody. The realistic mitigation is not to have
  the XSS: no dangerouslySetInnerHTML anywhere, no third-party script tags, and
  a token that expires in an hour rather than a fortnight.

  ---------------------------------------------------------------------------
  What signing out does not do

  It does not touch the study profile. `ielts-prep-v1`, the drills and the
  saved words stay exactly where they are. Signing out is not deleting, and a
  learner who signs out to hand the laptop back should not discover that a
  month of practice went with the session (ACCOUNTS.md, threat 5).
*/

const KEY = "bandup.session.v1";

export interface Session {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds. Absent when the provider did not say. */
  expiresAt: number | null;
  email: string | null;
}

/*
  The server render and the first client render must agree, or React replaces
  the tree and the header flickers between "Sign in" and an account name. Both
  start from null and the real value arrives on subscribe, which is the same
  shape lib/store.ts uses.
*/
const SIGNED_OUT: Session | null = null;

let cache: Session | null | undefined;
const listeners = new Set<() => void>();

function read(): Session | null {
  if (typeof window === "undefined") return SIGNED_OUT;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return SIGNED_OUT;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (typeof parsed.accessToken !== "string" || parsed.accessToken.length === 0) {
      return SIGNED_OUT;
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : null,
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : null,
      email: typeof parsed.email === "string" ? parsed.email : null,
    };
  } catch {
    return SIGNED_OUT;
  }
}

function emit() {
  for (const l of listeners) l();
}

export function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  /*
    Sign out in one tab signs out the others. Without this a second tab keeps
    showing an account screen backed by a token that has been thrown away, and
    every action on it fails for no visible reason.
  */
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY || e.key === null) {
      cache = undefined;
      emit();
    }
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function getSnapshot(): Session | null {
  if (cache === undefined) cache = read();
  return cache;
}

export function getServerSnapshot(): Session | null {
  return SIGNED_OUT;
}

export function saveSession(session: Session): void {
  cache = session;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(session));
    } catch {
      // Private mode, or storage full. The in-memory copy still works for this
      // tab, so the user is signed in until they close it rather than being
      // told sign-in failed when it did not.
    }
  }
  emit();
}

/** Signs out locally. Progress is deliberately untouched — see the header. */
export function clearSession(): void {
  cache = SIGNED_OUT;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      // Nothing useful to do; the in-memory clear above already took effect.
    }
  }
  emit();
}

/** True when the token is past, or within a minute of, its stated expiry. */
export function isExpired(session: Session | null, now = Date.now()): boolean {
  if (!session) return true;
  if (session.expiresAt === null) return false;
  // A minute of slack, so a request is not sent with a token that expires
  // while it is in flight.
  return session.expiresAt - 60_000 <= now;
}

/*
  Refreshing goes through our own API for the same reason signing in does: the
  browser has no Supabase credential to present, and giving it one would end
  the no-credential-in-the-bundle invariant.

  Returns the new session, or null when the refresh token is spent — in which
  case the caller signs out rather than retrying, because a rejected refresh
  token does not become valid by being sent again.
*/
export async function refreshSession(session: Session, apiBase = ""): Promise<Session | null> {
  if (!session.refreshToken) return null;
  try {
    const res = await fetch(`${apiBase}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<Session>;
    if (typeof body.accessToken !== "string" || body.accessToken.length === 0) return null;
    return {
      accessToken: body.accessToken,
      refreshToken: typeof body.refreshToken === "string" ? body.refreshToken : session.refreshToken,
      expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : null,
      email: typeof body.email === "string" ? body.email : session.email,
    };
  } catch {
    return null;
  }
}

/**
 * `fetch` with the access token attached, refreshed first if it has expired.
 *
 * Signed out is not an error here. Every metered route already has to work for
 * an anonymous caller, so this sends the request without a token rather than
 * refusing to make it.
 */
export async function authedFetch(
  input: string,
  init: RequestInit = {},
  apiBase = "",
): Promise<Response> {
  let session = getSnapshot();

  if (session && isExpired(session)) {
    const next = await refreshSession(session, apiBase);
    if (next) {
      saveSession(next);
      session = next;
    } else {
      clearSession();
      session = null;
    }
  }

  const headers = new Headers(init.headers);
  if (session) headers.set("Authorization", `Bearer ${session.accessToken}`);
  return fetch(input, { ...init, headers });
}

/*
  Parsing the fragment GoTrue leaves on the callback URL.

  Exported so it can be tested without a browser: this is the one piece of the
  sign-in flow whose correctness can be checked here at all, since nothing in
  this environment can reach a real identity provider.
*/
export function sessionFromFragment(fragment: string, now = Date.now()): Session | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  const accessToken = params.get("access_token");
  if (!accessToken) return null;

  const expiresIn = Number(params.get("expires_in"));
  return {
    accessToken,
    refreshToken: params.get("refresh_token"),
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
    email: null,
  };
}

/** The error GoTrue reports in the same fragment when sign-in fails. */
export function errorFromFragment(fragment: string): string | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  const description = params.get("error_description");
  const code = params.get("error");
  if (!description && !code) return null;
  /*
    Provider text is shown, but only after being cut to a length and stripped
    of anything that is not plain prose. It arrives via the URL bar, so it is
    attacker-supplied in the case that matters, and it is about to be rendered.
  */
  const raw = description ?? code ?? "";
  const clean = raw.replace(/[<>]/g, "").slice(0, 200).trim();
  return clean.length > 0 ? clean : null;
}
