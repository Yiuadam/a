/*
  lib/usage/ip.ts: the caller's address, well enough to rate-limit and never
  well enough to identify.

  clientIp reads the platform's own proxy headers; hashIp turns that address
  into an HMAC-SHA256 under a server-only salt, truncated to 32 hex
  characters. The hash is asserted against a value computed independently
  with Node's own `crypto` module (see the comment above it), so a wrong
  algorithm name, a dropped `.trim()`/`.slice()`, or a broken hex pad all show
  up as a different string rather than merely "some string".
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const ip = await import(
  pathToFileURL(join(process.cwd(), "lib", "usage", "ip.ts")).href
);
const { clientIp, hashIp } = ip;

const req = (headers) => new Request("https://bandup.life/api/x", { headers });

/* --------------------------------------------------------------- clientIp -- */

test("clientIp reads the leftmost x-forwarded-for address", () => {
  assert.equal(clientIp(req({ "x-forwarded-for": "203.0.113.5" })), "203.0.113.5");
});

test("clientIp takes the first of a comma-separated list and trims it, not just the first character", () => {
  // A delimiter mutated from "," to "" would split on every character and
  // return just "2"; a dropped .trim() would leave the surrounding space in.
  assert.equal(clientIp(req({ "x-forwarded-for": " 203.0.113.9 ,198.51.100.2" })), "203.0.113.9");
});

test("an x-forwarded-for whose first entry is blank falls through to x-real-ip, not to an empty string", () => {
  assert.equal(
    clientIp(req({ "x-forwarded-for": ",198.51.100.2", "x-real-ip": "192.0.2.77" })),
    "192.0.2.77",
  );
});

test("clientIp falls back to a trimmed x-real-ip when x-forwarded-for is absent", () => {
  assert.equal(clientIp(req({ "x-real-ip": " 192.0.2.44 " })), "192.0.2.44");
});

test("clientIp is null when neither header is present", () => {
  assert.equal(clientIp(req({})), null);
});

/* ----------------------------------------------------------------- hashIp -- */

function withSalt(salt, fn) {
  const saved = process.env.USAGE_IP_HASH_SALT;
  if (salt === undefined) delete process.env.USAGE_IP_HASH_SALT;
  else process.env.USAGE_IP_HASH_SALT = salt;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (saved === undefined) delete process.env.USAGE_IP_HASH_SALT;
      else process.env.USAGE_IP_HASH_SALT = saved;
    });
}

/*
  Independently computed (node:crypto's createHmac, and separately Node's own
  webcrypto — both agree, see the pull request notes): HMAC-SHA256("203.0.113.42")
  under this salt, hex, truncated to 32 characters. Byte 14 of the signature is
  0x04 — a value that only round-trips correctly through `.padStart(2, "0")` —
  so this input specifically exercises the hex padding, not just the happy case
  where every byte is already two characters wide.
*/
const SALT = "test-salt-for-mutation";
const SUBJECT_IP = "203.0.113.42";
const EXPECTED_HASH = "eed0ddf5a5f1f0fec8bb1c4524042c3f";

test("hashIp matches an independently computed HMAC-SHA256, truncated to 32 hex characters", () =>
  withSalt(SALT, async () => {
    const hash = await hashIp(SUBJECT_IP);
    assert.equal(hash, EXPECTED_HASH);
    assert.equal(hash.length, 32);
    assert.match(hash, /^[0-9a-f]{32}$/);
  }));

test("hashIp is stable for the same address and salt, and differs for a different address", () =>
  withSalt(SALT, async () => {
    assert.equal(await hashIp(SUBJECT_IP), EXPECTED_HASH);
    assert.notEqual(await hashIp("203.0.113.43"), EXPECTED_HASH);
  }));

test("hashIp returns null with no salt configured, even for a real address", () =>
  withSalt(undefined, async () => {
    assert.equal(await hashIp(SUBJECT_IP), null);
  }));

test("hashIp returns null for a null address, even with a salt configured", () =>
  withSalt(SALT, async () => {
    assert.equal(await hashIp(null), null);
  }));

/* ----------------------------------------------------- server-only guard -- */

test("hashIp refuses to run outside the server, naming this module", async () => {
  globalThis.window = {};
  try {
    await assert.rejects(
      () => hashIp("203.0.113.1"),
      (error) => error instanceof Error && error.message.includes("lib/usage/ip.ts"),
    );
  } finally {
    delete globalThis.window;
  }
});
