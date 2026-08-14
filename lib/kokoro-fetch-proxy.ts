"use client";

import { kokoroSameOriginAssetPath } from "./kokoro-model-delivery";

type KokoroFetchWindow = Window & {
  __bandupKokoroFetchProxyInstalled?: boolean;
};

function redirectedPath(input: RequestInfo | URL): string | null {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  return kokoroSameOriginAssetPath(raw);
}

/*
  kokoro-js does not expose transformers.js's `remoteHost` setting. Its model
  and voice loader do resolve `fetch` at call time, however, so one narrowly
  scoped page-level relay keeps the vetted runtime usable on networks that
  block Hugging Face. Only the four exact model files and Emma's local voice
  are rewritten; every other request still goes straight to the browser.
*/
export function installKokoroAssetFetchProxy(): void {
  if (typeof window === "undefined") return;
  const target = window as KokoroFetchWindow;
  if (target.__bandupKokoroFetchProxyInstalled) return;

  const nativeFetch = window.fetch.bind(window) as typeof fetch;
  const proxyFetch: typeof fetch = (input, init) => {
    const redirected = redirectedPath(input);
    if (!redirected) return nativeFetch(input, init);
    if (input instanceof Request) {
      // kokoro-js only performs GETs, but preserving a Request's headers keeps
      // its cache and range semantics correct if the vendor changes that.
      return nativeFetch(new Request(new URL(redirected, window.location.origin), input));
    }
    return nativeFetch(redirected, init);
  };

  window.fetch = proxyFetch;
  target.__bandupKokoroFetchProxyInstalled = true;
}
