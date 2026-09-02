"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { saveSession } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { IS_MOBILE_BUILD } from "@/lib/platform";
import { getServerTheme, getTheme, subscribeTheme } from "@/lib/theme";
import LoadingIndicator from "@/components/LoadingIndicator";
import { consumeAuthReturnPath } from "@/lib/auth/return-path";

/*
  Continue with Apple.

  ---------------------------------------------------------------------------
  Why there is no Apple script on this page

  Google's button is Google's own, rendered by their script into an iframe this
  page cannot style, which is why GoogleSignIn.tsx loads gsi/client and wraps
  what comes back in a glass rim. Apple publishes a JavaScript library that does
  something similar, and it is not used here. The whole of what it would buy is a
  popup instead of a full-page navigation; what it costs is a third-party script
  on the sign-in page and a client id in the browser. The redirect through
  /api/auth/apple/start is Apple's own documented server flow, it keeps every
  identifier on the Worker, and it is the same shape the app already uses for
  every other provider redirect.

  So the button below is BandUp's markup, and that means BandUp is responsible
  for it looking the way Apple requires.

  ---------------------------------------------------------------------------
  What Apple requires of it

  The rules that are followed here deliberately: the mark is Apple's own glyph,
  unaltered and not recoloured beyond the two permitted appearances; the button
  is solid black on a light background and solid white on a dark one, never
  translucent and never over a photograph; the wording is one of Apple's
  permitted strings; the type is the system font; the target is comfortably
  above the 30pt minimum height; and nothing is layered over it. In particular
  there is no glass here, unlike the Google button beside it — the material
  would be an alteration of an appearance Apple specifies exactly, and a rim of
  translucent white around a white button is the sort of thing App Review
  notices.

  The rules that have *not* been checked, and must be before submission: the
  exact ratio of type size to button height, the exact glyph height, the leading
  and trailing clear space, and the minimum width. Those are numbers in a
  document Apple revises, and what is below is faithful in shape, colour and
  wording without having been measured against the current revision. The same
  caveat is written over the marks in SignedOut.tsx, and it is the same caveat.

  ---------------------------------------------------------------------------
  Which of the two doors this button opens

  There are two, and the split is the same one GoogleSignIn.tsx describes.
  /api/auth/apple/start is the direct flow, and it exists only where the
  Cloudflare-native account authority is live *and* this Worker holds all four
  Apple credentials. Everywhere else, Apple is still reached the way it has
  always been reached here — /api/auth/start?provider=apple, which redirects
  through Supabase. /api/auth/apple/config answers which of the two is true, and
  until it says otherwise this button keeps pointing at the established path.

  That is what makes the absent credentials harmless. This deployment has none
  of them, because they require a paid Apple Developer Program membership that
  does not exist yet, and nothing about that changes what a learner sees: the
  config answers false, the button addresses the Supabase route exactly as it
  did before any of this was written, and the direct routes answer 404 to
  anybody who goes looking. Whether the button appears at all is decided further
  up, by /api/account/status — which offers Apple only where some Apple flow
  genuinely works. A button that fails on the first tap reads as a broken app;
  the point of every check in this paragraph is that there is never one.
*/

interface ConfigResponse {
  enabled?: boolean;
}

interface SessionResponse {
  error?: string;
  accessToken?: string;
  refreshToken?: string | null;
  expiresAt?: number | null;
  email?: string | null;
}

/*
  What the iOS plugin answers with. `nonce` is the raw value the device
  generated; what went to Apple was its SHA-256 digest, and the server hashes
  this again to compare — so the raw nonce is only ever seen by the phone and by
  BandUp, never by Apple. `givenName` and `familyName` are populated on the very
  first authorization and are null on every one after it, which is Apple's
  behaviour rather than a shortcoming of the plugin.
*/
interface AppleAuthorization {
  identityToken?: string | null;
  nonce?: string | null;
  givenName?: string | null;
  familyName?: string | null;
}

interface SignInWithApplePluginApi {
  authorize(): Promise<AppleAuthorization>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: {
    SignInWithApple?: SignInWithApplePluginApi;
  };
}

/*
  No import from `@capacitor/core`, for the reason lib/billing/storefront.ts
  gives: `registerPlugin` on a plugin that is not there returns a proxy which
  throws on every call, and what is wanted here is a plainly absent value so the
  web fallback can be chosen instead.
*/
function nativePlugin(): SignInWithApplePluginApi | null {
  if (typeof window === "undefined") return null;
  const capacitor = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  if (!capacitor?.isNativePlatform?.()) return null;
  return capacitor.Plugins?.SignInWithApple ?? null;
}

/*
  Apple's mark, drawn rather than fetched: a cross-origin <img> on a page that
  may be cross-origin isolated is a needless dependency for one shape this
  small, and nominative use in a sign-in button is exactly what the mark is for.

  20px against 15px type, chosen by looking at 18, 20 and 22 side by side in a
  browser — the glyph's cap height then sits level with the text's, which is
  what Apple's ratio is trying to achieve. The one-pixel lift is an optical
  correction: the path is bottom-heavy inside its own box, so a mark centred by
  the layout reads as sitting slightly low.
*/
function AppleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 18 18" width="20" height="20" aria-hidden="true" className={className}>
      <path
        fill="currentColor"
        d="M12.32 9.53c-.02-1.86 1.52-2.76 1.59-2.8-.87-1.27-2.22-1.44-2.7-1.46-1.15-.12-2.24.68-2.83.68-.58 0-1.48-.66-2.43-.65-1.25.02-2.4.73-3.05 1.84-1.3 2.26-.33 5.6.93 7.43.62.9 1.35 1.9 2.31 1.86.93-.04 1.28-.6 2.4-.6s1.44.6 2.42.58c1-.02 1.63-.91 2.24-1.81.71-1.04 1-2.05 1.01-2.1-.02-.01-1.94-.75-1.96-2.97ZM10.5 3.87c.51-.62.86-1.48.76-2.34-.74.03-1.63.49-2.16 1.11-.47.55-.89 1.43-.78 2.27.83.07 1.67-.42 2.18-1.04Z"
      />
    </svg>
  );
}

export default function AppleSignIn() {
  const router = useRouter();
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getServerTheme);
  const [enabled, setEnabled] = useState(false);
  const [configReady, setConfigReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(apiUrl("/api/auth/apple/config"), { cache: "no-store" })
      .then(async (res) => (res.ok ? ((await res.json()) as ConfigResponse) : null))
      .then((data) => {
        if (live) setEnabled(data?.enabled === true);
      })
      .catch(() => {
        /*
          An unreachable config is treated as "not offered" rather than as a
          failure worth reporting. The other doors on this screen are drawn from
          the same page load and are unaffected, and a learner who cannot reach
          this endpoint could not have reached Apple's either.
        */
        if (live) setEnabled(false);
      })
      .finally(() => {
        if (live) setConfigReady(true);
      });
    return () => {
      live = false;
    };
  }, []);

  async function signInNatively(plugin: SignInWithApplePluginApi) {
    setBusy(true);
    setError(null);
    try {
      const authorization = await plugin.authorize();
      const credential = authorization.identityToken ?? "";
      const nonce = authorization.nonce ?? "";
      if (!credential || !nonce) {
        setError("Apple sign-in could not be completed. Please try again.");
        return;
      }
      const res = await fetch(apiUrl("/api/auth/apple/token"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          credential,
          nonce,
          /*
            Forwarded exactly as Apple gave them, on the one request that will
            ever carry them. They are null on every later sign-in, and the
            server writes them only onto a profile that has no name yet.
          */
          givenName: authorization.givenName ?? null,
          familyName: authorization.familyName ?? null,
        }),
      });
      const data = (await res.json().catch(() => null)) as SessionResponse | null;
      if (!res.ok || !data?.accessToken) {
        setError(data?.error ?? "Apple sign-in could not be completed. Please try again.");
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
      /*
        A cancelled sheet arrives here as a rejection indistinguishable from a
        real failure, so this says the mildest true thing rather than announcing
        an error to somebody who simply changed their mind.
      */
      setError("Apple sign-in didn't finish. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  /*
    Black on light, white on dark. Apple offers a third appearance — white with
    a black outline — for cases where a solid white button would disappear into
    the background; neither of this app's two surfaces is one of those.
  */
  const appearance = theme === "dark" ? "bg-white text-black" : "bg-black text-white";
  const label = "Continue with Apple";
  const classes = [
    "mx-auto flex min-h-11 w-full max-w-[406px] items-center justify-center gap-2",
    "rounded-full px-5 text-[15px] font-medium tracking-[-0.01em]",
    appearance,
    busy ? "pointer-events-none opacity-60" : "",
  ].join(" ");

  /*
    The direct route while it is available, the established one otherwise. Both
    end at the same account-callback page with a session in the fragment, so
    which one a learner took is not visible to them and does not need to be.
  */
  const start = enabled
    ? apiUrl("/api/auth/apple/start")
    : apiUrl("/api/auth/start?provider=apple");

  /*
    Held back until the config has answered, rather than drawn immediately with
    the fallback address and corrected a moment later. The two addresses are
    different sign-ins, and a button whose destination changes under the pointer
    is a button that occasionally starts the wrong one.
  */
  if (!configReady) {
    return (
      <div className={`${classes} pointer-events-none`} aria-hidden="true">
        <LoadingIndicator label="Loading Apple sign-in…" announce={false} />
      </div>
    );
  }

  if (IS_MOBILE_BUILD) {
    const plugin = enabled ? nativePlugin() : null;
    if (plugin) {
      return (
        <div>
          <button
            type="button"
            className={classes}
            disabled={busy}
            onClick={() => {
              void signInNatively(plugin);
            }}
          >
            {busy ? <LoadingIndicator label="Signing in…" announce={false} /> : (
              <>
                <AppleMark className="shrink-0 -mt-px" />
                {label}
              </>
            )}
          </button>
          {error && (
            <p className="mt-2 text-center text-xs leading-5 text-rose-700" role="alert">
              {error}
            </p>
          )}
        </div>
      );
    }
    /*
      No plugin means a build of the app whose binary predates it, or a
      deployment where the direct flow is not available anyway. The redirect
      still works inside the WebView — it is an ordinary navigation out to Apple
      and back — so it is offered rather than the button being withdrawn. It is
      the less pleasant of the two: iOS shows the native sheet for the plugin
      and a web page for this.
    */
    return (
      <a href={start} className={classes}>
        <AppleMark className="shrink-0 -mt-px" />
        {label}
      </a>
    );
  }

  return (
    <a href={start} className={classes}>
      <AppleMark className="shrink-0 -mt-px" />
      {label}
    </a>
  );
}
