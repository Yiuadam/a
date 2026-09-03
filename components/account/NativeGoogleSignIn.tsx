"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import LoadingIndicator from "@/components/LoadingIndicator";
import { saveSession } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { consumeAuthReturnPath } from "@/lib/auth/return-path";

/*
  Google sign-in inside the app, through the system's OAuth sheet.

  GoogleSignIn.tsx is the website's button and cannot serve here: it renders by
  running a script from accounts.google.com, and its fallback navigates away to
  Google — which Capacitor cancels and hands to Safari, signing the learner in
  somewhere the app cannot read. This talks to GoogleSignInPlugin.swift instead,
  which presents ASWebAuthenticationSession and returns the signed ID token that
  /api/auth/google/token already knows how to accept.

  Everything about the exchange after that is identical to Apple's — see
  AppleSignIn.tsx, whose shape this deliberately follows, down to a cancelled
  sheet being an ordinary outcome rather than an error worth announcing.
*/

interface GoogleAuthorization {
  credential?: string | null;
  nonce?: string | null;
  cancelled?: boolean;
}

interface GoogleSignInPluginApi {
  authorize(options: { clientId: string }): Promise<GoogleAuthorization>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: { GoogleSignIn?: GoogleSignInPluginApi };
}

interface ConfigResponse {
  enabled?: boolean;
  iosClientId?: string | null;
}

interface SessionResponse {
  accessToken?: string;
  refreshToken?: string | null;
  expiresAt?: number | null;
  email?: string | null;
  error?: string;
}

/*
  No import from `@capacitor/core`, for the reason lib/billing/storefront.ts
  gives and AppleSignIn.tsx repeats: `registerPlugin` on a plugin that is not
  there returns a proxy that throws on every call, and what is wanted is a
  plainly absent value so the caller can decide not to draw a button at all.
*/
export function nativeGooglePlugin(): GoogleSignInPluginApi | null {
  if (typeof window === "undefined") return null;
  const capacitor = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  if (!capacitor?.isNativePlatform?.()) return null;
  return capacitor.Plugins?.GoogleSignIn ?? null;
}

/*
  Google's mark, drawn rather than fetched, for the reason AppleSignIn.tsx
  gives about its own: a cross-origin image on a page that may be cross-origin
  isolated is a needless dependency for one shape this small, and the four
  colours are fixed by Google's guidelines so there is nothing to theme.
*/
function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}

const subscribeNothing = () => () => {};
const serverSnapshot = (): GoogleSignInPluginApi | null => null;

export default function NativeGoogleSignIn() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
    Whether the native plugin is there, read through useSyncExternalStore so
    the prerendered shell and the app's first paint disagree on purpose rather
    than by accident: the server snapshot is always null, the client snapshot
    reads the global, and React reconciles the two itself.

    Nothing to subscribe to. The plugin is registered in capacitorDidLoad,
    before the web view loads, and never appears or disappears afterwards — so
    the subscribe function exists only to satisfy the signature.
  */
  const plugin = useSyncExternalStore(subscribeNothing, nativeGooglePlugin, serverSnapshot);

  /*
    Which Google client this app is, asked of the server rather than compiled
    in — the same value Info.plist's redirect scheme is derived from, so a
    deployment that has not created an iOS client yet returns null here and no
    button is drawn. A Google button that cannot complete is worse than none,
    which is what the old website-link version was.
  */
  const [clientId, setClientId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(apiUrl("/api/auth/google/config"), { cache: "no-store" })
      .then(async (res) => (res.ok ? ((await res.json()) as ConfigResponse) : null))
      .then((data) => {
        if (!live) return;
        setClientId(
          data?.enabled && typeof data.iosClientId === "string" && data.iosClientId.length > 0
            ? data.iosClientId
            : null,
        );
      })
      /* Unreachable config means "not offered", exactly as in AppleSignIn. */
      .catch(() => {
        if (live) setClientId(null);
      });
    return () => {
      live = false;
    };
  }, []);

  if (!plugin || !clientId) return null;

  async function signIn(api: GoogleSignInPluginApi, id: string) {
    setBusy(true);
    setError(null);
    try {
      const authorization = await api.authorize({ clientId: id });
      // A closed sheet is somebody changing their mind, not a failure.
      if (authorization.cancelled) return;
      const credential = authorization.credential ?? "";
      const nonce = authorization.nonce ?? "";
      if (!credential || !nonce) {
        setError("Google sign-in could not be completed. Please try again.");
        return;
      }
      const res = await fetch(apiUrl("/api/auth/google/token"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential, nonce }),
      });
      const data = (await res.json().catch(() => null)) as SessionResponse | null;
      if (!res.ok || !data?.accessToken) {
        setError(data?.error ?? "Google sign-in could not be completed. Please try again.");
        return;
      }
      saveSession({
        accessToken: data.accessToken,
        refreshToken: data.refreshToken ?? null,
        expiresAt: data.expiresAt ?? null,
        email: data.email ?? null,
      });
      router.replace(consumeAuthReturnPath("/"));
      router.refresh();
    } catch {
      setError("Google sign-in didn't finish. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="btn-secondary flex min-h-10 w-full items-center justify-center gap-2 rounded-full text-[0.9375rem] font-medium"
        onClick={() => void signIn(plugin, clientId)}
        disabled={busy}
      >
        {busy ? (
          <LoadingIndicator label="Signing in…" announce={false} />
        ) : (
          <>
            <GoogleMark />
            Continue with Google
          </>
        )}
      </button>
      {error && (
        <p role="alert" className="text-[0.8125rem] leading-5 text-rose-700">
          {error}
        </p>
      )}
    </div>
  );
}
