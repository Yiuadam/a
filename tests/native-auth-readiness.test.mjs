/*
  The native credential switch must fail closed.  This is deliberately a
  local-only test: it has no Worker binding, browser, provider or credential.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const readiness = await import(
  pathToFileURL(join(process.cwd(), "lib", "cloudflare", "native-auth-readiness.ts")).href,
);

const KEYS = [
  "CLOUDFLARE_NATIVE_AUTH",
  "CLOUDFLARE_DATA_MODE",
  "ORGANIZATION_DATA_MODE",
];

async function withEnv(values, run) {
  const previous = new Map(KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of KEYS) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
    return await run();
  } finally {
    for (const key of KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("native Cloudflare auth activates only when both data authorities are final", async () => {
  await withEnv({
    CLOUDFLARE_NATIVE_AUTH: "1",
    CLOUDFLARE_DATA_MODE: "cloudflare",
    ORGANIZATION_DATA_MODE: "cloudflare",
  }, () => {
    assert.deepEqual(readiness.nativeAuthDataAuthority(), {
      learner: "cloudflare",
      organization: "cloudflare",
      ready: true,
    });
    assert.equal(readiness.nativeAuthCutoverActive(), true);
  });

  await withEnv({
    CLOUDFLARE_NATIVE_AUTH: "1",
    CLOUDFLARE_DATA_MODE: "cloudflare",
    ORGANIZATION_DATA_MODE: "read_cloudflare",
  }, () => {
    assert.equal(readiness.nativeAuthDataAuthority().ready, false);
    assert.equal(readiness.nativeAuthCutoverActive(), false);
  });

  await withEnv({
    CLOUDFLARE_NATIVE_AUTH: "0",
    CLOUDFLARE_DATA_MODE: "cloudflare",
    ORGANIZATION_DATA_MODE: "cloudflare",
  }, () => {
    assert.equal(readiness.nativeAuthDataAuthority().ready, true);
    assert.equal(readiness.nativeAuthCutoverActive(), false);
  });
});
