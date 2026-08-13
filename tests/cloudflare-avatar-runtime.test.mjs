import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);
const delivery = await load("lib", "cloudflare", "avatar-delivery.ts");
const storage = await load("lib", "cloudflare", "avatar-storage.ts");
const learnerData = await load("lib", "cloudflare", "learner-data.ts");

const SECRET = "avatar-test-signing-key-with-at-least-thirty-two-bytes";
const USER = "499f408e-a012-48a0-ab0d-7aa1f7ca103b";
const OTHER_USER = "0cebdcfd-ecd6-4242-9361-25f8c0f7cb7c";
const KEY = `private/avatars/${USER}/${"a".repeat(64)}.webp`;
const NOW = 1_800_000_000;

async function grantUrl(userId = USER, objectKey = KEY) {
  return delivery.cloudflareAvatarUrl("https://api.bandup.test/account", userId, objectKey, {
    nowSeconds: NOW,
    secret: SECRET,
  });
}

test("private avatar grants are browser-loadable, short-lived and bound to the exact key", async () => {
  const url = new URL(await grantUrl());
  assert.equal(url.origin, "https://api.bandup.test");
  assert.equal(url.pathname, "/api/account/avatar/file");
  const grant = await delivery.verifyCloudflareAvatarGrant(url.searchParams.get("grant"), {
    nowSeconds: NOW,
    secret: SECRET,
  });
  assert.deepEqual(grant, {
    userId: USER,
    objectKey: KEY,
    expiresAt: NOW + delivery.AVATAR_URL_TTL_SECONDS,
  });
});

test("tampered, expired and cross-user avatar grants are rejected", async () => {
  const url = new URL(await grantUrl());
  const signed = url.searchParams.get("grant");
  assert.ok(signed);
  const [token, signature] = signed.split(".");

  assert.equal(await delivery.verifyCloudflareAvatarGrant(null, {
    nowSeconds: NOW,
    secret: SECRET,
  }), null);

  const tamperedSignature = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
  assert.equal(await delivery.verifyCloudflareAvatarGrant(`${token}.${tamperedSignature}`, {
    nowSeconds: NOW,
    secret: SECRET,
  }), null);
  assert.equal(await delivery.verifyCloudflareAvatarGrant(signed, {
    nowSeconds: NOW + delivery.AVATAR_URL_TTL_SECONDS,
    secret: SECRET,
  }), null);

  const decoded = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  decoded.u = OTHER_USER;
  const crossUserToken = Buffer.from(JSON.stringify(decoded)).toString("base64url");
  assert.equal(await delivery.verifyCloudflareAvatarGrant(`${crossUserToken}.${signature}`, {
    nowSeconds: NOW,
    secret: SECRET,
  }), null);

  const mismatchedOwner = new URL(await grantUrl(USER, KEY.replace(USER, OTHER_USER)));
  assert.equal(await delivery.verifyCloudflareAvatarGrant(
    mismatchedOwner.searchParams.get("grant"),
    { nowSeconds: NOW, secret: SECRET },
  ), null);
});

test("a same-key retry never deletes the object that is still live", async () => {
  const events = [];
  assert.equal(await storage.replaceAvatarObject({
    previousKey: "same",
    nextKey: "same",
    storeNext: async () => events.push("store:same"),
    setPointer: async () => false,
    deleteObject: async (key) => events.push(`delete:${key}`),
  }), false);
  assert.deepEqual(events, ["store:same"]);
});

test("delivery checks the live owner pointer before touching private R2", async () => {
  let fetched = 0;
  const bindings = {
    db: {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return { avatar_object_key: KEY };
              },
            };
          },
        };
      },
    },
    files: {
      async get(key) {
        fetched += 1;
        return { key };
      },
    },
  };

  assert.equal(
    await learnerData.getCloudflareAvatarObject(USER, `private/avatars/${USER}/old.webp`, bindings),
    null,
  );
  assert.equal(fetched, 0, "a stale/cross-pointer grant must not reach R2");
  assert.deepEqual(await learnerData.getCloudflareAvatarObject(USER, KEY, bindings), { key: KEY });
  assert.equal(fetched, 1);
});

test("a deletion prepared during R2 upload removes the new orphan and never commits it", async () => {
  const oldKey = `private/avatars/${USER}/${"b".repeat(64)}.webp`;
  let deleting = false;
  let pointerWrites = 0;
  const deleted = [];
  const bindings = {
    db: {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes("SELECT p.display_name")) {
                  return {
                    display_name: null,
                    birth_date: null,
                    avatar_object_key: oldKey,
                    email: "learner@example.test",
                  };
                }
                if (sql.includes("account_deletion_tombstones")) {
                  return deleting ? { state: "prepared" } : null;
                }
                return null;
              },
              async run() {
                pointerWrites += 1;
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
    files: {
      async put() {
        deleting = true;
      },
      async delete(key) {
        deleted.push(key);
      },
    },
  };

  await assert.rejects(
    learnerData.putCloudflareAvatar(
      { id: USER, email: "learner@example.test" },
      Uint8Array.from([0x52, 0x49, 0x46, 0x46]).buffer,
      { ext: "webp", mime: "image/webp" },
      bindings,
    ),
    /deletion is already in progress/i,
  );
  assert.equal(pointerWrites, 0);
  assert.equal(deleted.length, 1);
  assert.notEqual(deleted[0], oldKey, "the still-live old pointer must not be deleted by the losing upload");
});

test("replacement stores, updates the pointer, then deletes the old object", async () => {
  const events = [];
  assert.equal(await storage.replaceAvatarObject({
    previousKey: "old",
    nextKey: "next",
    storeNext: async () => events.push("store:next"),
    setPointer: async (key) => {
      events.push(`pointer:${key}`);
      return true;
    },
    deleteObject: async (key) => events.push(`delete:${key}`),
  }), true);
  assert.deepEqual(events, ["store:next", "pointer:next", "delete:old"]);
});

test("a failed pointer update preserves the live old object and cleans only the orphan", async () => {
  const events = [];
  assert.equal(await storage.replaceAvatarObject({
    previousKey: "old",
    nextKey: "next",
    storeNext: async () => events.push("store:next"),
    setPointer: async () => {
      events.push("pointer:failed");
      return false;
    },
    deleteObject: async (key) => events.push(`delete:${key}`),
  }), false);
  assert.deepEqual(events, ["store:next", "pointer:failed", "delete:next"]);
});

test("removal clears the pointer before deleting private R2", async () => {
  const events = [];
  assert.equal(await storage.clearAvatarObject({
    previousKey: "old",
    clearPointer: async () => {
      events.push("pointer:null");
      return true;
    },
    deleteObject: async (key) => events.push(`delete:${key}`),
  }), true);
  assert.deepEqual(events, ["pointer:null", "delete:old"]);
});

test("Cloudflare learner mode never falls back to a public R2 URL or Supabase profile read", () => {
  const profile = readFileSync(join(process.cwd(), "app/api/account/profile/route.ts"), "utf8");
  const avatar = readFileSync(join(process.cwd(), "app/api/account/avatar/route.ts"), "utf8");
  const file = readFileSync(join(process.cwd(), "app/api/account/avatar/file/route.ts"), "utf8");
  const learner = readFileSync(join(process.cwd(), "lib/cloudflare/learner-data.ts"), "utf8");
  const editor = readFileSync(join(process.cwd(), "components/account/ProfileSection.tsx"), "utf8");
  assert.match(profile, /mode === "cloudflare"[\s\S]*cloudflareAvatarUrl/);
  assert.match(avatar, /cloudflareDataMode\(\) === "cloudflare"[\s\S]*putCloudflareAvatar/);
  assert.match(file, /verifyCloudflareAvatarGrant/);
  assert.match(file, /getCloudflareAvatarObject/);
  assert.doesNotMatch(file, /r2\.dev|publicUrl|signedAvatarUrl|getSessionUser/);
  assert.match(learner, /account_deletion_tombstones/);
  assert.match(learner, /avatar_object_key IS \?[\s\S]*NOT EXISTS/);
  assert.match(editor, /publishProfileUpdate\(\{ avatarUrl \}\)/);
});
