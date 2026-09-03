import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const component = readFileSync(join(root, "components/account/GoogleSignIn.tsx"), "utf8");
const tokenRoute = readFileSync(join(root, "app/api/auth/google/token/route.ts"), "utf8");
const configRoute = readFileSync(join(root, "app/api/auth/google/config/route.ts"), "utf8");
const supabase = readFileSync(join(root, "lib/auth/supabase.ts"), "utf8");

test("web Google sign-in uses Google Identity Services instead of the Supabase redirect", () => {
  assert.match(component, /https:\/\/accounts\.google\.com\/gsi\/client/);
  assert.match(component, /google\.accounts|accounts\?\.id/);
  assert.match(component, /use_fedcm_for_prompt:\s*true/);
  assert.match(component, /\/api\/auth\/google\/token/);
  assert.doesNotMatch(component, /supabase\.co/);
});

test("the Google nonce is hashed for Google and sent raw to Supabase", () => {
  assert.match(component, /crypto\.getRandomValues/);
  assert.match(component, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(component, /nonce:\s*hashed/);
  assert.match(component, /JSON\.stringify\(\{ credential, nonce \}\)/);
  assert.match(supabase, /provider:\s*"google"/);
  assert.match(supabase, /id_token:\s*idToken/);
  assert.match(supabase, /nonce,/);
});

test("Google auth API stays server-mediated and CORS-capable", () => {
  for (const route of [tokenRoute, configRoute]) {
    assert.match(route, /withCors/);
    assert.match(route, /export \{ OPTIONS \}/);
  }
  assert.match(tokenRoute, /signInWithGoogleIdToken/);
  assert.match(configRoute, /googleClientId/);
});

/*
  The app signs in with Google through the system's OAuth sheet, and this
  component is not what does it.

  What must never come back is the branch this file used to carry: a plain link
  to the server's Google start route. Capacitor answers a top-level navigation
  off the app's own origin by opening it in Safari, so the learner signed in on
  the website and returned to an app that was still signed out. That is why the
  assertion below is about this component staying free of any mobile branch —
  the native path lives in NativeGoogleSignIn.tsx and GoogleSignInPlugin.swift,
  and a second, quieter route back into Safari is exactly the regression worth
  failing a build over.

  The app's button also refuses to draw itself unless it can work: the plugin
  has to be registered and the deployment has to have an iOS Google client. A
  build made before either is done offers Apple and email rather than a Google
  button that ends in an error.
*/
test("the app's Google sign-in is native, and this component stays a website one", () => {
  const signedOut = readFileSync(join(root, "components/account/SignedOut.tsx"), "utf8");
  const native = readFileSync(join(root, "components/account/NativeGoogleSignIn.tsx"), "utf8");

  // The app draws the native button; the website keeps Google Identity Services.
  assert.match(signedOut, /IS_MOBILE_BUILD \? \(\s*<NativeGoogleSignIn key=\{id\} \/>/);
  // And this file still has no idea it is ever running inside an app.
  assert.doesNotMatch(component, /IS_MOBILE_BUILD/);

  // The sheet, not a navigation: the plugin returns a credential to post.
  assert.match(native, /capacitor\?\.isNativePlatform\?\.\(\)/);
  assert.match(native, /capacitor\.Plugins\?\.GoogleSignIn/);
  assert.match(native, /apiUrl\("\/api\/auth\/google\/token"\)/);
  assert.doesNotMatch(native, /href=/, "a link is how the broken version worked");

  // Nothing is drawn without both halves of what makes it work.
  assert.match(native, /if \(!plugin \|\| !clientId\) return null;/);

  const plugin = readFileSync(join(root, "ios/App/App/GoogleSignInPlugin.swift"), "utf8");
  assert.match(plugin, /ASWebAuthenticationSession/);
  // response_type=id_token, so no client secret is needed and none can ship.
  assert.match(plugin, /response_type", value: "id_token"/);
  assert.doesNotMatch(plugin, /client_secret/);
  // The digest goes to Google and the raw nonce to BandUp, as Apple's does.
  assert.match(plugin, /name: "nonce", value: Self\.sha256Hex\(nonce\)/);
  assert.match(plugin, /"nonce": nonce/);

  const main = readFileSync(join(root, "ios/App/App/MainViewController.swift"), "utf8");
  assert.match(main, /registerPluginInstance\(googleSignIn\)/);
});

test("web Google sign-in falls back to the established full-navigation flow", () => {
  assert.match(component, /const \[loadFailed, setLoadFailed\] = useState\(false\)/);
  assert.match(component, /onError=\{\(\) => setLoadFailed\(true\)\}/);
  assert.match(component, /\.catch\(\(\) => \{\s*if \(live\) setLoadFailed\(true\);/);
  assert.match(component, /identity\.renderButton[\s\S]*setLoadFailed\(false\)/);
  assert.match(
    component,
    /const legacyGoogleStart = apiUrl\("\/api\/auth\/start\?provider=google"\);/,
  );
  assert.match(
    component,
    /const fallbackStart = nativeAuth \? googleServerStart : legacyGoogleStart;/,
  );
  assert.match(
    component,
    /loadFailed && \([\s\S]*href=\{fallbackStart\}[\s\S]*data-google-signin-fallback/,
  );
  assert.match(component, /aria-describedby="google-signin-fallback-help"/);
  assert.match(component, /id="google-signin-fallback-help"[\s\S]*role="status"/);
});

test("Google sign-in uses its supported pill inside BandUp glass", () => {
  assert.match(component, /shape:\s*"pill"/);
  assert.match(component, /google-signin-glass premade-glass/);
  /* The glass frame around Google's own button is frosted material and
     nothing else. It used to carry a displacement layer as well; that was
     rejected on how it looked — the ask is transparent glass, not a fogged
     or bent one — so the surface keeps its tint, border and blur and the
     lens does not come back. */
  assert.doesNotMatch(component, /RefractiveGlassLayer/);
  assert.match(component, /theme === "dark" \? "filled_black" : "outline"/);
});
