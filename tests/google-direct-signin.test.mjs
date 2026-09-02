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
  The iOS build offers no Google sign-in at all, and two things hold that.

  The sign-in screen drops Google from the providers it will draw a button for
  whenever IS_MOBILE_BUILD is set, and this component no longer carries a
  mobile branch of its own. The second matters as much as the first: that
  branch rendered a plain link to the server's Google start route, and
  Capacitor answers a top-level navigation off the app's origin by opening it
  in Safari — so the learner signed in on the website and came back to an app
  that was still signed out. Between them they also keep the app inside
  guideline 4.8's exception for an app that uses only its own account system,
  which is why this is a test and not a preference.
*/
test("the iOS build offers no Google sign-in at all", () => {
  const signedOut = readFileSync(join(root, "components/account/SignedOut.tsx"), "utf8");
  assert.match(signedOut, /import \{ IS_MOBILE_BUILD \} from "@\/lib\/platform";/);
  assert.match(
    signedOut,
    /providers\.includes\(p\.id\) && !\(IS_MOBILE_BUILD && p\.id === "google"\)/,
  );
  assert.doesNotMatch(component, /IS_MOBILE_BUILD/);
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
