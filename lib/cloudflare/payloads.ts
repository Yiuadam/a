import type { BandUpCloudflareBindings } from "./bindings";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const INLINE_LIMIT = 96 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256(value: Uint8Array): Promise<string> {
  // Wrangler's generated runtime types allow a Uint8Array backed by a
  // SharedArrayBuffer, while Web Crypto deliberately requires an owned
  // ArrayBuffer. Copying here makes that boundary explicit and portable
  // across Node, next dev and workerd.
  const owned = Uint8Array.from(value);
  return hex(await crypto.subtle.digest("SHA-256", owned.buffer));
}

export interface StoredJson {
  inline: string | null;
  objectKey: string | null;
  sha256: string;
  bytes: number;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
}

async function deletionState(
  bindings: BandUpCloudflareBindings,
  owner: string,
): Promise<string | null> {
  const row = await bindings.db.prepare(`
    SELECT state FROM account_deletion_tombstones WHERE user_id = ?
  `).bind(owner).first<{ state: string }>();
  return row?.state ?? null;
}

function deletionInProgress(): Error {
  return new Error("Cloudflare account deletion is already in progress");
}

/**
 * If deletion crossed an R2 upload, atomically hand that exact object to its
 * durable manifest. Prefix listing covers the opposite ordering (the
 * tombstone appears after this check), so no object can fall between them.
 */
async function captureDeletionRace(
  bindings: BandUpCloudflareBindings,
  owner: string,
  objectKey: string,
): Promise<boolean> {
  const stamp = new Date().toISOString();
  await bindings.db.prepare(`
    INSERT OR IGNORE INTO account_deletion_objects (user_id, object_key, discovered_at)
    SELECT user_id, ?, ? FROM account_deletion_tombstones
     WHERE user_id = ? AND state <> 'complete'
  `).bind(objectKey, stamp, owner).run();
  const state = await deletionState(bindings, owner);
  if (!state) return false;
  if (state === "complete") {
    // A delayed upload after completion must not recreate a private object.
    await bindings.files.delete(objectKey);
  }
  return true;
}

export async function storeJson(
  bindings: BandUpCloudflareBindings,
  namespace: string,
  owner: string,
  value: unknown,
  options: { forceObject?: boolean } = {},
): Promise<StoredJson> {
  const json = JSON.stringify(value);
  const bytes = encoder.encode(json);
  if (bytes.byteLength > MAX_JSON_BYTES) throw new Error("JSON payload exceeds the storage limit");
  const digest = await sha256(bytes);
  if (bytes.byteLength <= INLINE_LIMIT && !options.forceObject) {
    // The caller's D1 write is protected by table-level deletion triggers, so
    // the common inline path needs no extra read.
    return { inline: json, objectKey: null, sha256: digest, bytes: bytes.byteLength };
  }

  if (await deletionState(bindings, owner)) throw deletionInProgress();
  const key = `private/${safeSegment(namespace)}/${safeSegment(owner)}/${digest}.json`;
  await bindings.files.put(key, bytes, {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: "private, max-age=31536000, immutable",
    },
    customMetadata: { sha256: digest },
  });
  if (await captureDeletionRace(bindings, owner, key)) {
    throw deletionInProgress();
  }
  return { inline: null, objectKey: key, sha256: digest, bytes: bytes.byteLength };
}

export async function readStoredJson(
  bindings: BandUpCloudflareBindings,
  stored: StoredJson,
): Promise<unknown> {
  let bytes: Uint8Array;
  if (stored.inline !== null) {
    bytes = encoder.encode(stored.inline);
  } else if (stored.objectKey) {
    const object = await bindings.files.get(stored.objectKey);
    if (!object) throw new Error("Cloudflare object is missing");
    bytes = new Uint8Array(await object.arrayBuffer());
  } else {
    throw new Error("Stored payload has no content");
  }

  if (bytes.byteLength !== stored.bytes || (await sha256(bytes)) !== stored.sha256) {
    throw new Error("Cloudflare object checksum mismatch");
  }
  return JSON.parse(decoder.decode(bytes)) as unknown;
}
