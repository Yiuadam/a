"use client";

import Script from "next/script";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { saveSession } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { IS_MOBILE_BUILD } from "@/lib/platform";

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
      theme: "outline";
      size: "large";
      text: "continue_with";
      shape: "rectangular";
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
 * Google talks to this page directly, then BandUp exchanges the signed ID
 * token with Supabase on the server. The account chooser therefore identifies
 * BandUp/bandup.life instead of the Supabase project hostname.
 */
export default function GoogleSignIn() {
  const router = useRouter();
  const hostRef = useRef<HTMLDivElement>(null);
  const rawNonceRef = useRef<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [configReady, setConfigReady] = useState(false);
  const [scriptReady, setScriptReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (IS_MOBILE_BUILD) return;
    let live = true;
    fetch(apiUrl("/api/auth/google/config"), { cache: "no-store" })
      .then(async (res) => (res.ok ? ((await res.json()) as ConfigResponse) : null))
      .then((data) => {
        if (!live) return;
        const configuredClientId =
          data?.enabled && typeof data.clientId === "string" ? data.clientId : null;
        setClientId(configuredClientId);
        if (!configuredClientId) setError("Google sign-in is not configured yet.");
      })
      .catch(() => {
        if (live) setError("Google sign-in could not be loaded. Please try again.");
      })
      .finally(() => {
        if (live) setConfigReady(true);
      });
    return () => {
      live = false;
    };
  }, []);

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
          theme: "outline",
          size: "large",
          text: "continue_with",
          shape: "rectangular",
          logo_alignment: "left",
          width: Math.max(240, Math.min(400, Math.floor(host.getBoundingClientRect().width))),
        });
      })
      .catch(() => {
        if (live) setError("Google sign-in could not be loaded. Please try again.");
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
        router.replace("/account/");
        router.refresh();
      } catch {
        setError("Couldn't reach the server. Please check your connection and try again.");
      } finally {
        setBusy(false);
      }
    }
  }, [clientId, router, scriptReady]);

  if (IS_MOBILE_BUILD) {
    return (
      <a href={apiUrl("/api/auth/start?provider=google")} className="btn-secondary">
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
        onError={() => setError("Google sign-in could not be loaded. Please try again.")}
      />
      <div
        ref={hostRef}
        className={busy ? "flex min-h-10 justify-center opacity-50 pointer-events-none" : "flex min-h-10 justify-center"}
        aria-label="Continue with Google"
      />
      {(!scriptReady || !configReady) && !error && (
        <div className="btn-secondary min-h-10" aria-live="polite">
          Loading Google sign-in…
        </div>
      )}
      {busy && <p className="mt-2 text-center text-xs text-slate-500">Signing in…</p>}
      {error && (
        <p className="mt-2 text-center text-xs leading-5 text-rose-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
