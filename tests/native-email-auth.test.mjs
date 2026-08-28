import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const email = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "native-email.ts")).href
);
const password = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "native-password.ts")).href
);

test("native email action links keep their one-time token out of the server request URL", () => {
  const token = `${crypto.randomUUID()}.Aq2xPmJv8lL6wTwC1roTXV2lKx3y4GqfNpuZHrD9aBc`;
  assert.deepEqual(email.parseNativeEmailActionToken(token), { id: token.slice(0, 36), token });
  assert.equal(email.parseNativeEmailActionToken(`${crypto.randomUUID()}.not-a-valid-token`), null);
  assert.equal(email.parseNativeEmailActionToken("not-a-token"), null);

  const url = new URL(email.nativeEmailCallbackUrl("https://organization-preview.bandup.life", "confirm", token));
  assert.equal(url.origin, "https://organization-preview.bandup.life");
  assert.equal(url.pathname, "/account/callback/");
  assert.equal(url.search, "");
  assert.match(url.hash, /email_action=confirm/);
  assert.match(url.hash, /email_token=/);
});

test("new native passwords use the bounded bcrypt verifier accepted by the imported-account path", async () => {
  const verifier = await password.hashNativePassword("a long enough BandUp password");
  assert.equal(password.isImportedBcryptVerifier(verifier), true);
  assert.equal(await password.verifyImportedBcryptPassword("a long enough BandUp password", verifier), true);
  assert.equal(await password.verifyImportedBcryptPassword("the wrong password", verifier), false);
});

test("native email confirmation is gated, one-time, and uses Cloudflare Email Sending", () => {
  const registration = readFileSync(join(process.cwd(), "app", "api", "auth", "password", "route.ts"), "utf8");
  const recovery = readFileSync(join(process.cwd(), "app", "api", "auth", "recover", "route.ts"), "utf8");
  const consume = readFileSync(join(process.cwd(), "app", "api", "auth", "email", "consume", "route.ts"), "utf8");
  const callback = readFileSync(join(process.cwd(), "components", "AccountCallback.tsx"), "utf8");
  const implementation = readFileSync(join(process.cwd(), "lib", "auth", "native-email.ts"), "utf8");
  const migration = readFileSync(join(process.cwd(), "cloudflare", "migrations", "0017_native_email_actions.sql"), "utf8");
  const previewConfig = readFileSync(join(process.cwd(), "wrangler.preview.jsonc"), "utf8");
  const productionConfig = readFileSync(join(process.cwd(), "wrangler.jsonc"), "utf8");

  assert.match(registration, /startNativePasswordRegistration/);
  assert.match(recovery, /startNativeAccountRecovery/);
  assert.match(consume, /nativeAuthCutoverActive\(\)/);
  assert.match(consume, /consumeNativeEmailAction/);
  assert.match(callback, /\/api\/auth\/email\/consume/);
  assert.match(implementation, /token_sha256/);
  assert.match(implementation, /target\.hash/);
  assert.match(implementation, /sender\.send/);
  assert.match(implementation, /user\.status === "pending"/);
  assert.doesNotMatch(implementation, /\?email_token=/);
  assert.match(migration, /status IN \('pending', 'active'\)/);
  assert.match(migration, /consumed_at/);
  assert.match(previewConfig, /"send_email"/);
  assert.match(productionConfig, /"send_email"/);
});
