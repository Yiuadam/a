import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";

/* Next's config test helper expects the web-runtime global that Next installs
   in production. Node's test runner has the implementation but does not put it
   on globalThis for framework modules. */
globalThis.AsyncLocalStorage ??= AsyncLocalStorage;
const { getRedirectUrl, unstable_getResponseFromNextConfig } = await import(
  "next/experimental/testing/server.js"
);
const { default: nextConfig } = await import("../next.config.ts");

function getResponse(url, headers = {}) {
  return unstable_getResponseFromNextConfig({ url, headers, nextConfig });
}

test("plain HTTP apex requests permanently redirect to the secure canonical origin", async () => {
  const response = await getResponse(
    "http://bandup.life/account?return=%2Forganization%3Fsection%3Dteam",
    { "x-forwarded-proto": "http" },
  );

  assert.equal(response.status, 308);
  assert.equal(
    getRedirectUrl(response),
    "https://bandup.life/account?return=%2Forganization%3Fsection%3Dteam",
  );
});

test("www redirects on either scheme and preserves path and query", async () => {
  for (const protocol of ["http", "https"]) {
    const response = await getResponse(
      `${protocol}://www.bandup.life/practice/writing?id=w8&mode=free`,
      { "x-forwarded-proto": protocol },
    );

    assert.equal(response.status, 308);
    assert.equal(
      getRedirectUrl(response),
      "https://bandup.life/practice/writing?id=w8&mode=free",
    );
  }
});

test("canonical HTTPS, localhost, preview and lookalike hosts are never redirected", async () => {
  for (const [url, forwardedProto] of [
    ["https://bandup.life/account", "https"],
    ["http://localhost:3100/account", "http"],
    ["https://organization-preview.bandup.life/account", "https"],
    ["https://www.bandup.life.example/account", "https"],
  ]) {
    const response = await getResponse(url, {
      "x-forwarded-proto": forwardedProto,
    });
    assert.equal(response.status, 200, url);
    assert.equal(getRedirectUrl(response), null, url);
  }
});

test("HTTPS apex is not redirected by a spoofed HTTP URL alone", async () => {
  const response = await getResponse("http://bandup.life/account", {
    "x-forwarded-proto": "https",
  });

  assert.equal(response.status, 200);
  assert.equal(getRedirectUrl(response), null);
});
