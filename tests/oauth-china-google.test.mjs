/*
  Google's own services are blocked inside mainland China, so offering the
  Google sign-in button there is an invitation to tap something that can
  only ever fail, silently, with nothing on this side explaining why.

  Nothing here can run a Worker, so the pure filter (providersReachableFrom)
  is exercised directly, and the route's wiring is checked against its
  source — the same shape tests/pricing-currency.test.mjs uses for the same
  reason: CF-IPCountry only exists on a real request.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");
const oauth = await import(pathToFileURL(join(root, "lib", "auth", "oauth.ts")).href);

test("providersReachableFrom drops Google for mainland China and nowhere else", () => {
  const both = ["google", "apple"];
  assert.deepEqual(oauth.providersReachableFrom("CN", both), ["apple"]);
  // Hong Kong, Macau and Taiwan are each their own CF-IPCountry value —
  // never "CN" — and Google is reachable from all three, so none of them
  // should lose the button this filter exists to remove elsewhere.
  for (const elsewhere of ["HK", "MO", "TW", "US", "GB", "SG"]) {
    assert.deepEqual(oauth.providersReachableFrom(elsewhere, both), both, elsewhere);
  }
  // No request at all (local development) narrows nothing.
  assert.deepEqual(oauth.providersReachableFrom(null, both), both);
});

test("providersReachableFrom only ever removes google, never invents a provider", () => {
  assert.deepEqual(oauth.providersReachableFrom("CN", ["apple"]), ["apple"]);
  assert.deepEqual(oauth.providersReachableFrom("CN", []), []);
});

test("the account status route reads CF-IPCountry itself and narrows the offered providers with it", () => {
  const route = read("app", "api", "account", "status", "route.ts");
  assert.match(
    route,
    /providersReachableFrom\(\s*req\.headers\.get\("cf-ipcountry"\),/,
  );
  assert.match(route, /import \{ OAUTH_PROVIDERS, providersReachableFrom \} from "@\/lib\/auth\/oauth";/);
});

test("the Google button's only gates are the providers list and the iOS filter — SignedOut renders nothing else that could show it anyway", () => {
  const signedOut = read("components", "account", "SignedOut.tsx");
  assert.match(
    signedOut,
    /available = PROVIDER_BUTTONS\.filter\(\s*\(p\) => providers\.includes\(p\.id\)/,
  );
  // GoogleSignIn itself is only ever reached through that filtered list, and so
  // is AppleSignIn now that Apple's button is a component rather than a link.
  assert.match(signedOut, /available\.map\(\(\{ id \}\) =>[\s\S]*?<GoogleSignIn/);
  assert.match(signedOut, /available\.map\(\(\{ id \}\) =>[\s\S]*?<AppleSignIn/);
});
