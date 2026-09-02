"use client";

/*
  Whether this copy of the app is allowed to link out to the website to be paid.

  The answer is a matter of law rather than of design, and it is not the same
  everywhere. Guideline 3.1.1 has always said an iOS app may not point people
  at a way to buy things that isn't In-App Purchase, which is why the four
  places that mention a plan name bandup.life in prose and stop there. In April
  2025 a US court held Apple in contempt over exactly that rule and enjoined it
  from enforcing the part about external links, or from taking a commission on
  what they lead to. Apple changed the US guidelines the following day.

  So a link is lawful on the United States storefront and nowhere else. The
  European position is different again — the DMA permits linking under Apple's
  alternative business terms, but those are a separate contract with a fee
  attached, and opting into them is a decision about the whole business rather
  than about this component.

  Hence: ask the device which storefront it is on, link only from the ones on
  the list, and say the sentence everywhere else. The list is here, in one
  place, because it is the thing that will change.

  ---------------------------------------------------------------------------
  Why the safe answer is the default

  `storefrontCountry` is asynchronous and the first render cannot wait for it.
  Everything here therefore starts at "no link" and only ever moves to "link"
  once a storefront has actually confirmed it — never the other way round. A
  link that appears a moment late is invisible; one that flashes up in Hong
  Kong before being taken away is the exact thing the guideline forbids, and it
  would be on screen at the moment a reviewer is watching.

  No import from `@capacitor/core` here, for the reason lib/native-chrome.ts
  gives: `registerPlugin` on a plugin that isn't there returns a proxy that
  throws on every call, and this file wants a plain absent value instead.
*/
import { useEffect, useState } from "react";
import { IS_MOBILE_BUILD, WEB_HOME } from "@/lib/platform";

/*
  Storefronts where an app may link to an external purchase page.

  StoreKit reports these as ISO 3166-1 alpha-3 — "USA", not "US" — but both
  spellings are accepted below, because a two-letter code is what anyone
  extending this list will reach for first and being wrong about it would fail
  open, which is the direction that matters.
*/
const EXTERNAL_LINK_STOREFRONTS = new Set(["USA", "US"]);

interface StorefrontPluginApi {
  /** The current App Store storefront, as an ISO 3166-1 alpha-3 country code. */
  getCountry(): Promise<{ country: string | null }>;
  /** Opens a URL outside the app, in the learner's own browser. */
  openExternal(options: { url: string }): Promise<void>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: {
    Storefront?: StorefrontPluginApi;
  };
}

function getPlugin(): StorefrontPluginApi | null {
  if (typeof window === "undefined") return null;
  const capacitor = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  if (!capacitor?.isNativePlatform?.()) return null;
  return capacitor.Plugins?.Storefront ?? null;
}

/*
  Asked once per launch and remembered.

  A storefront changes when someone changes the Apple ID their device is signed
  in to, which is not something that happens between two screens of a practice
  test. Re-asking on every render of every gate would be a StoreKit call in a
  render path for no gain.
*/
let cached: Promise<string | null> | null = null;

function storefrontCountry(): Promise<string | null> {
  if (cached) return cached;
  const plugin = getPlugin();
  if (!plugin) {
    cached = Promise.resolve(null);
    return cached;
  }
  cached = plugin
    .getCountry()
    .then(({ country }) => (typeof country === "string" ? country.toUpperCase() : null))
    .catch(() => null);
  return cached;
}

/**
 * The URL to send someone to for their plan, or `null` to say nothing but the
 * sentence.
 *
 * On the website this is not used at all — the pages are right there, and the
 * callers link to them directly. It answers only for the iOS build, where the
 * pages are not in the bundle and whether they may even be pointed at depends
 * on the storefront.
 *
 * @param path a route on the website — "/pricing" to choose a plan,
 *   "/billing" to manage one that already exists.
 */
export function useExternalPlansUrl(path = "/pricing"): string | null {
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    if (!IS_MOBILE_BUILD) return;
    let live = true;
    void storefrontCountry().then((country) => {
      if (live && country && EXTERNAL_LINK_STOREFRONTS.has(country)) setAllowed(true);
    });
    return () => {
      live = false;
    };
  }, []);

  return allowed ? `https://${WEB_HOME}${path}` : null;
}

/**
 * Opens one of those URLs, in the learner's browser rather than in the app.
 *
 * It has to leave the app. A WKWebView told to navigate to the website would
 * replace the bundled app with the live site and strand the learner there with
 * no way back — and a purchase page inside the app's own web view is arguably
 * the in-app purchase flow the guideline is about, which is the opposite of
 * what this is for.
 */
export function openPlansExternally(url: string): void {
  const plugin = getPlugin();
  if (plugin) {
    plugin.openExternal({ url }).catch(() => {
      // Nothing to recover to: there is no second way out of the app, and a
      // failed open leaves the learner exactly where they already were.
    });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
