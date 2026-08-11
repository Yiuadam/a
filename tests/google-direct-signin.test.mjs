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

test("native builds retain the established OAuth compatibility path", () => {
  assert.match(component, /IS_MOBILE_BUILD/);
  assert.match(component, /\/api\/auth\/start\?provider=google/);
});
