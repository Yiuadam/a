import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

/*
  Adapts the Next.js build to run on Cloudflare Workers.

  `npm run build` already prerenders every route with no request-time data
  dependency — 52 of them, and `grep -rn "export const revalidate" app` finds
  none, so nothing here ever needs to go stale and get re-rendered on a
  schedule. The build writes that output to `.open-next/cache/<BUILD_ID>/*.cache`
  regardless of the setting below; what the setting decides is whether a
  request ever reads it. The default `incrementalCache: "dummy"` never does,
  which is why every request — including a request for a page that was fully
  known at build time — re-ran the page through React on the Worker: the
  difference between reading a file and re-running the program that would
  have produced it, and the Free plan bills exactly that difference, 10 ms CPU
  per request. `staticAssetsIncrementalCache` is the read-only counterpart:
  it looks a prerendered entry up through Workers Static Assets (the same
  `ASSETS` binding that already serves `_next/static`) and only ever reads —
  calling `.set()` logs and does nothing. That is the right shape here and
  would be the wrong one anywhere ISR is in use, because a read-only cache can
  only ever be as fresh as the build that populated it.

  `enableCacheInterception` is what makes the lookup happen before Next ever
  runs: OpenNext's routing layer checks the prerender manifest first and, for
  a route it lists, answers straight out of `incrementalCache` — HTML for a
  normal navigation, the RSC payload for a client one — without constructing
  the React tree or evaluating the Next server bundle at all. That bundle
  evaluation is most of the fixed cost on a cold Worker isolate (100+ ms),
  which is the number worth cutting under a 10 ms budget, not just the render
  it was hiding. It buys nothing for a route the prerender manifest never
  listed: a dynamic page such as `/pricing` (reads `headers()` for the
  visitor's country) and every `/api/*` route still run the Next server
  exactly as before, request for request.

  One more step, outside this file, has to actually happen for any of this to
  be reachable: `.open-next/cache` has to be copied into `.open-next/assets`
  so the `ASSETS` binding can see it. `opennextjs-cloudflare build` does not
  do that on its own — see the `cf:build` script in package.json, which runs
  `populateCache local` immediately after.
*/
const cloudflareConfig = {
  ...defineCloudflareConfig({
    incrementalCache: staticAssetsIncrementalCache,
    enableCacheInterception: true,
  }),
  /* Turbopack cannot create its CSS helper port inside the desktop sandbox.
     Webpack produces the same standalone Next output without that local IPC. */
  buildCommand: "npx next build --webpack",
};

export default cloudflareConfig;
