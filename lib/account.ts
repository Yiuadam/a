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
  What signing out touches, and why that is no longer the same for both paths

  `clearSession` is unchanged: it still leaves the study profile alone.
  `ielts-prep-v1`, the drills and the saved words stay exactly where they are,
  because this is the path an expired refresh token takes, not a choice the
  learner made — the same person is still sitting at the same tab, and losing
  in-progress work to a silent token refresh would be its own bug (ACCOUNTS.md,
  threat 5).

  `signOutSession` — the button someone presses on purpose — now clears the
  study profile too, which the first version of this file deliberately did
  not. That version reasoned "signing out is not deleting" and left local
  progress in place; what it missed is that sessionStorage recorded no owner,
  so the next person to sign in on the same tab inherited whatever was sitting
  there regardless of whose it was. That is a confirmed leak, not a
  theoretical one — see lib/progress/storage.ts for the marker that now
  records ownership and lib/progress/sync.ts for where a mismatched owner is
  refused. Clearing outright on sign-out is the belt to that braces, and it
  costs the person leaving nothing: the account, not the tab, has been the
  durable copy since sync shipped, so signing back in fetches the same
  practice straight back.
*/

/*
  The only import in this file, and worth explaining why it is safe. This
  module has no React in it and is not itself a component, but it has always
  been "use client" — every function here reads `window` directly, and
  nothing server-side has ever imported it (grepping the API routes for it
  finds nothing). lib/progress/storage.ts is the same shape: also "use
  client", also guarded on `typeof window === "undefined"` in every export, so
  it is already safe wherever this file already is. And the dependency only
  runs one way — storage.ts imports nothing, so there is no cycle to create by
  reaching into it from here.
*/
import { clearProgressStore } from "@/lib/progress/storage";

/*
  Exported so components/account/ClearDeviceSection.tsx can keep it. That file
  wipes the whole origin and puts back a named list, which is the right
  direction to be wrong in — but it means anything not on the list is deleted,
  and deleting this one signs the learner out of an account the same screen
  promises not to touch.
*/
export const SESSION_KEY = "bandup.session.v1";
const KEY = SESSION_KEY;

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

/**
 * Best-effort server revocation for Cloudflare-native sessions. The ordinary
 * local clear below remains authoritative for the device: a network error
 * must never prevent someone from signing out of this browser.
 */
export function revokeSession(apiBase = ""): void {
  const session = getSnapshot();
  if (!session) return;
  void fetch(`${apiBase}/api/auth/signout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.accessToken}` },
    keepalive: true,
  }).catch(() => undefined);
}

/**
 * Signs out after first confirming that the persisted token can be removed.
 *
 * The ordinary `clearSession` remains deliberately best-effort for expired
 * credentials: even when storage is unavailable, an expired token must stop
 * being used in the current tab. A user-initiated sign-out is different. The
 * UI must not claim success and navigate away if a stored token could survive
 * the action and sign the person back in after a reload.
 */
export function signOutSession(): boolean {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      return false;
    }
  }
  cache = SIGNED_OUT;
  emit();

  /*
    Ordering is deliberate, and the token above goes first. This function's
    contract, established in the doc comment above, is about one thing only —
    can the token be removed — and nothing below this line may change what
    `true` or `false` means to a caller that has only read that contract. So
    the progress clear happens after the sign-out is already final, as a
    best-effort second step whose own failure is swallowed rather than
    reported through this function's return value.

    The alternative ordering — clearing progress first — would let a storage
    failure there abort a sign-out that was otherwise able to happen,
    leaving someone stuck signed in against their own explicit choice because
    of trouble with data that only matters to whoever uses this tab *next*.
    Clearing after does carry a real cost: if this throws, the token is gone
    but the previous account's progress is still sitting here, which is the
    exact leak this function exists to help close. That is accepted as the
    better of two bad outcomes — a storage failure here is rare, and stale
    progress left behind by one is corrected by this same function the next
    time anyone signs out of this tab, or by lib/progress/sync.ts's owner
    check the moment anyone next signs in and syncs. Refusing a sign-out the
    person explicitly asked for has no equivalent later fix.
  */
  try {
    clearProgressStore();
  } catch {
    // See above: a failure here must not be reported as a failed sign-out.
  }

  return true;
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

/**
 * The account id carried in the current session's access token, or null.
 *
 * Supabase issues a JWT, and a JWT's payload is only base64 — this reads it
 * without ever checking the signature, which is a different thing from
 * `userFromAccessToken` in lib/auth/supabase.ts, and deliberately so. That
 * function decides whether a request may happen at all, so it must never take
 * a client's word for anything and always asks the issuer instead: a token is
 * base64 anyone can write, and only Supabase can say a given one is real.
 * This function answers something smaller and later: once a request carrying
 * this exact token has already been *answered* — a 200 from the account, not
 * a 401 — which account it was answered for, so lib/progress/sync.ts can
 * label locally-held progress with an id the issuer has, by that point,
 * already vouched for. A forged or corrupted token cannot turn this into a
 * leak: it fails to authenticate, and the 401 branch in sync.ts returns
 * before this value is ever consulted. Anything this cannot parse — a
 * malformed token, or a non-JWT string, which is what every stand-in access
 * token in this codebase's own tests is — simply returns null, which
 * sync.ts already treats as "no local owner recorded", the same safe default
 * it used before this function existed.
 */
export function currentAccountId(): string | null {
  const session = getSnapshot();
  if (!session) return null;
  const segments = session.accessToken.split(".");
  if (segments.length !== 3) return null;
  try {
    const payload = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as { sub?: unknown };
    return typeof claims.sub === "string" && claims.sub.length > 0 ? claims.sub : null;
  } catch {
    return null;
  }
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
