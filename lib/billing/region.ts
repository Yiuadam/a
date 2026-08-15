import { headers } from "next/headers";
import { assertServerOnly } from "@/lib/auth/server-only";
import { currencyForCountry } from "./currency";

/*
  The visitor's currency, known before a single byte of HTML is written.

  ---------------------------------------------------------------------------
  What this fixes

  The pricing page already picked a currency from the reader's address, but it
  did it the long way round: the page was prerendered at build time with the
  base currency in it, the browser downloaded and ran the bundle, asked
  /api/billing/config where the reader was, and only then re-rendered with the
  right money. So somebody in London opened the page and read HK$4.90 —
  briefly on a fast connection, for as long as the round trip took on a slow
  one, and permanently if the request failed or scripts were blocked.

  A price is not a detail to get provisionally right. Cloudflare has already
  resolved the country by the time the Worker is invoked; reading it here puts
  the correct figure in the first HTML instead of correcting it afterwards.

  ---------------------------------------------------------------------------
  What it costs

  `headers()` is a request-time API, so the route that calls it renders per
  request rather than being served from the prerender. That is a real cost and
  it is worth being clear about it: /pricing goes from an asset read to a React
  render in the Worker. It buys a correct first paint and removes a blocking
  round trip from the page, and the documents were never cached at the edge
  anyway — every one of them carries `must-revalidate` (scripts/check-delivery.mjs).

  ---------------------------------------------------------------------------
  Why it can return null

  Two cases, and only one of them happens today.

  The one that happens: local development, where there is no Cloudflare in
  front and so no CF-IPCountry to read. The page then falls back to asking the
  API, exactly as it used to.

  The one that does not, yet: `npm run build:mobile` exports the app statically
  for the iOS bundle, and a static export has no request — calling `headers()`
  during it would fail the build. As it stands /pricing is not in that bundle
  at all (scripts/build-mobile.mjs moves it out, because Apple requires in-app
  purchase), so this guard never fires. It is here so that the first page that
  *is* exported and wants a currency does not discover the problem the hard
  way, and it is checked by a test rather than left as a hope.
*/

/** True when this is the static export that ships inside the iOS app. */
function staticExport(): boolean {
  return process.env.MOBILE_BUILD === "1";
}

/**
 * The currency to print for whoever is asking, or null if that cannot be known
 * at render time.
 *
 * `CF-IPCountry` is added by Cloudflare in front of the Worker and cannot be
 * set by the caller — anything a client sends under that name is replaced — so
 * this is not something a reader can talk the page into.
 */
export async function visitorCurrency(): Promise<string | null> {
  assertServerOnly("lib/billing/region.ts");
  if (staticExport()) return null;
  const country = (await headers()).get("cf-ipcountry");
  /*
    Absent in local development and in the mobile export, present on every
    request Cloudflare serves. `currencyForCountry` already answers the
    fallback for an unknown country, so the only case handled separately here
    is "there was no request at all".
  */
  if (country === null) return null;
  return currencyForCountry(country);
}
