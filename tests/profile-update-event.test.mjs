import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const browserEvents = new EventTarget();
globalThis.window = {
  addEventListener: browserEvents.addEventListener.bind(browserEvents),
  removeEventListener: browserEvents.removeEventListener.bind(browserEvents),
  dispatchEvent: browserEvents.dispatchEvent.bind(browserEvents),
};

if (typeof globalThis.CustomEvent === "undefined") {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, init = {}) {
      super(type);
      this.detail = init.detail;
    }
  };
}

const { PROFILE_UPDATED_EVENT, publishProfileUpdate } = await import(
  pathToFileURL(join(process.cwd(), "components", "account", "profileEvents.ts")).href
);

test("a successful avatar save is announced to persistent UI", () => {
  let received = null;
  const listen = (event) => {
    received = event.detail;
  };
  window.addEventListener(PROFILE_UPDATED_EVENT, listen);

  publishProfileUpdate({ avatarUrl: "https://example.test/new-avatar.jpg" });

  assert.deepEqual(received, { avatarUrl: "https://example.test/new-avatar.jpg" });
  window.removeEventListener(PROFILE_UPDATED_EVENT, listen);
});

test("profile updates can clear an avatar without losing the explicit null", () => {
  let received = undefined;
  const listen = (event) => {
    received = event.detail.avatarUrl;
  };
  window.addEventListener(PROFILE_UPDATED_EVENT, listen);

  publishProfileUpdate({ avatarUrl: null });

  assert.equal(received, null);
  window.removeEventListener(PROFILE_UPDATED_EVENT, listen);
});
