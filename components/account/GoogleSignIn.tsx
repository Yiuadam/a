"use client";

import Script from "next/script";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { saveSession } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { IS_MOBILE_BUILD } from "@/lib/platform";
import { getServerTheme, getTheme, subscribeTheme } from "@/lib/theme";
import LoadingIndicator from "@/components/LoadingIndicator";
import { consumeAuthReturnPath } from "@/lib/auth/return-path";

interface GoogleCredentialResponse {
  credential?: string;
}

interface GoogleIdentityServices {
  initialize(config: {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
    nonce: string;
    use_fedcm_for_prompt?: boolean;
  }): void;
  renderButton(
    parent: HTMLElement,
    options: {
      type: "standard";
      theme: "outline" | "filled_black";
      size: "large";
      text: "continue_with";
      shape: "pill";
      logo_alignment: "left";
      width: number;
    },
  ): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdentityServices } };
  }
}

interface ConfigResponse {
  enabled?: boolean;
  clientId?: string;
  native?: boolean;
  serverFlow?: boolean;
}

interface SessionResponse {
  error?: string;
  accessToken?: string;
  refreshToken?: string | null;
  expiresAt?: number | null;
  email?: string | null;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function googleNonce(): Promise<{ raw: string; hashed: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const raw = base64Url(bytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const hashed = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return { raw, hashed };
}

/**
 * Google talks to this page directly and BandUp verifies the signed ID token
 * on its server. Once Cloudflare-native identity is enabled, neither this
 * button nor its full-page fallback passes a Google credential to Supabase.
 */
export default function GoogleSignIn() {
  const router = useRouter();
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getServerTheme);
  const hostRef = useRef<HTMLDivElement>(null);
  const rawNonceRef = useRef<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [nativeAuth, setNativeAuth] = useState(false);
  const [serverFlow, setServerFlow] = useState(false);
  const [configReady, setConfigReady] = useState(false);
  const [scriptReady, setScriptReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(apiUrl("/api/auth/google/config"), { cache: "no-store" })
      .then(async (res) => (res.ok ? ((await res.json()) as ConfigResponse) : null))
      .then((data) => {
        if (!live) return;
        const configuredClientId =
          data?.enabled && typeof data.clientId === "string" ? data.clientId : null;
        setClientId(configuredClientId);
        setNativeAuth(data?.native === true);
        setServerFlow(data?.serverFlow === true);
        if (!configuredClientId) setError("Google sign-in is not configured yet.");
      })
      .catch(() => {
        if (live) setLoadFailed(true);
      })
      .finally(() => {
        if (live) setConfigReady(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const googleServerStart = apiUrl("/api/auth/google/start");
  const legacyGoogleStart = apiUrl("/api/auth/start?provider=google");
  // During the staged migration, the old route remains only until the native
  // cutover is active. At cutover every Google route is direct-to-Google.
  const fallbackStart = nativeAuth ? googleServerStart : legacyGoogleStart;

  useEffect(() => {
    const identity = window.google?.accounts?.id;
    const host = hostRef.current;
    if (!scriptReady || !clientId || !identity || !host) return;

    let live = true;
    googleNonce()
      .then(({ raw, hashed }) => {
        if (!live) return;
        rawNonceRef.current = raw;
        identity.initialize({
          client_id: clientId,
          nonce: hashed,
          use_fedcm_for_prompt: true,
          callback: (response) => {
            void exchange(response);
          },
        });
        host.replaceChildren();
        identity.renderButton(host, {
          type: "standard",
          theme: theme === "dark" ? "filled_black" : "outline",
          size: "large",
          text: "continue_with",
          shape: "pill",
          logo_alignment: "left",
          width: Math.max(240, Math.min(400, Math.floor(host.getBoundingClientRect().width))),
        });
        setLoadFailed(false);
      })
      .catch(() => {
        if (live) setLoadFailed(true);
      });

    return () => {
      live = false;
      rawNonceRef.current = null;
      host.replaceChildren();
    };

    async function exchange(response: GoogleCredentialResponse) {
      const credential = response.credential;
      const nonce = rawNonceRef.current;
      if (!credential || !nonce) {
        setError("Google sign-in could not be completed. Please try again.");
        return;
      }

      setBusy(true);
      setError(null);
      try {
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
        setError("Couldn't reach the server. Please check your connection and try again.");
      } finally {
        setBusy(false);
      }
    }
  }, [clientId, router, scriptReady, theme]);

  if (IS_MOBILE_BUILD) {
    if (!configReady) {
      return <div className="btn-secondary min-h-10"><LoadingIndicator label="Loading Google sign-in…" /></div>;
    }
    if (nativeAuth && !serverFlow) {
      return (
        <p className="text-center text-xs leading-5 text-rose-700" role="alert">
          Google sign-in is being updated. Please try again shortly.
        </p>
      );
    }
    return (
      <a href={fallbackStart} className="btn-secondary">
        Continue with Google
      </a>
    );
  }

  return (
    <div>
      <Script
        src="https://accounts.google.com/gsi/client"
        strategy="afterInteractive"
        onReady={() => setScriptReady(true)}
        onError={() => setLoadFailed(true)}
      />
      <div className="google-signin-glass premade-glass relative mx-auto w-full max-w-[406px] rounded-full p-[3px]">
        <div className="google-signin-viewport premade-glass-content relative overflow-hidden rounded-full">
          <div
            ref={hostRef}
            className={
              loadFailed
                ? "google-signin-host flex min-h-10 w-full justify-center overflow-hidden rounded-full opacity-0 pointer-events-none"
                : busy
                ? "google-signin-host flex min-h-10 w-full justify-center overflow-hidden rounded-full opacity-50 pointer-events-none"
                : "google-signin-host flex min-h-10 w-full justify-center overflow-hidden rounded-full"
            }
            aria-label="Continue with Google"
            aria-hidden={loadFailed || undefined}
          />
          {(!scriptReady || !configReady) && !error && !loadFailed && (
            <div
              className="btn-secondary absolute inset-0 min-h-10 rounded-full"
              aria-live="polite"
            >
              <LoadingIndicator label="Loading Google sign-in…" />
            </div>
          )}
          {loadFailed && (
            nativeAuth && !serverFlow ? (
              <p
                className="absolute inset-0 flex items-center justify-center px-5 text-center text-xs text-rose-700"
                role="alert"
              >
                Google sign-in is being updated. Please try again shortly.
              </p>
            ) : (
              <a
                href={fallbackStart}
                className="btn-secondary absolute inset-0 min-h-10 rounded-full"
                aria-describedby="google-signin-fallback-help"
                data-google-signin-fallback
              >
                Continue with Google
              </a>
            )
          )}
        </div>
      </div>
      {loadFailed && !nativeAuth && (
        <p
          id="google-signin-fallback-help"
          className="mt-2 text-center text-xs leading-5 text-slate-500"
          role="status"
        >
          The Google button couldn&rsquo;t load in this browser. Continue to Google to sign in.
        </p>
      )}
      {loadFailed && nativeAuth && serverFlow && (
        <p
          id="google-signin-fallback-help"
          className="mt-2 text-center text-xs leading-5 text-slate-500"
          role="status"
        >
          The Google button couldn&rsquo;t load in this browser. Continue to Google to sign in.
        </p>
      )}
      {busy && <p className="mt-2 text-center text-xs text-slate-500"><LoadingIndicator label="Signing in…" /></p>}
      {error && (
        <p className="mt-2 text-center text-xs leading-5 text-rose-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
