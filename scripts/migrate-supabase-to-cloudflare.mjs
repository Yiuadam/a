#!/usr/bin/env node

/**
 * Resumable Supabase -> Cloudflare D1/R2 copy for BandUp application data.
 *
 * Safety contract:
 * - copy only; never UPDATE/DELETE the source;
 * - every source page gets a canonical SHA-256 checksum;
 * - every target row is idempotently upserted;
 * - the run/checkpoints/row map stay in D1 as immutable evidence, except that
 *   subject-tagged rows may be purged by the post-auth account deletion path;
 * - large JSON is private in R2 and is verified before the checkpoint commits;
 * - the script stops on the first count/hash mismatch.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   node scripts/migrate-supabase-to-cloudflare.mjs --local --dry-run
 *
 * Replace --local with --remote only for the isolated preview database after
 * the dry run and local rehearsal have passed.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { canonical, hash } from "./migration-hash.mjs";

const SOURCE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SOURCE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
// Resolve every Wrangler config and temporary local state relative to this
// repository, not to the shell directory from which the script was launched.
const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));
// This flag must exist before any argument validation calls `die()`. Keeping
// it below the first validation created a temporal-dead-zone crash for a
// missing/invalid target, hiding the actionable CLI message behind a
// ReferenceError before any migration work had begun.
let migrationRunStarted = false;
const productionTarget = args.has("--production");
const previewTarget = args.has("--preview");
if (productionTarget === previewTarget) {
  die("choose exactly one target: --preview or --production");
}
// The public organization preview is deliberately synthetic-only. A source
// migration must never reuse its Worker config or its D1/R2 bindings.
const CONFIG = join(
  REPOSITORY_ROOT,
  productionTarget ? "wrangler.jsonc" : "wrangler.migration-preview.jsonc",
);
const DATABASE = "BANDUP_DB";
const BUCKET = productionTarget ? "bandup-files-production" : "bandup-files-preview";
// Keep a generated SQL page comfortably below D1's 100 KB per-statement and
// 30-second batch limits, even when rows contain Unicode-heavy metadata.
const PAGE_SIZE = 40;
const INLINE_LIMIT = 96 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_AVATAR_BYTES = 10 * 1024 * 1024;
const target = args.has("--remote") ? "remote" : "local";
const dryRun = args.has("--dry-run");
const persistArgument = process.argv.slice(2).find((value) => value.startsWith("--persist-to="));
const persistPath = persistArgument?.slice("--persist-to=".length) || join(REPOSITORY_ROOT, ".wrangler/state/v3");

function die(message) {
  // Before a run exists, retain the compact CLI error. During a run, throw so
  // the finalizer can durably record a failed status rather than leaving an
  // ambiguous `running` record behind.
  if (migrationRunStarted) throw new Error(message);
  process.stderr.write(`Migration stopped: ${message}\n`);
  process.exit(1);
}

if (!SOURCE_URL || !SOURCE_KEY) die("set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
if (args.has("--remote") && args.has("--local")) die("choose only --local or --remote");
if (productionTarget && target !== "remote") {
  die("the production target requires --remote; local rehearsals must use --preview");
}
if (productionTarget && !args.has("--confirm-production=bandup-data-production")) {
  die("production requires --confirm-production=bandup-data-production");
}

function sql(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) die("encountered a non-finite number");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function iso(value, fallback = null) {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) die(`invalid timestamp: ${String(value)}`);
  return parsed.toISOString().replace(/(\.\d{3})Z$/, "$1000000Z");
}

function command(program, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, commandArgs, {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, WRANGLER_LOG_PATH: "/tmp/bandup-wrangler-migration.log" },
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    // `exit` can fire before piped stdout/stderr have fully drained. Resolve
    // only on `close`, otherwise a valid D1 JSON response may be truncated.
    child.on("close", (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(
        `${program} exited ${code ?? `by signal ${signal ?? "unknown"}`}`
          + (stderr ? `: ${stderr.slice(-1200)}` : ""),
      ));
    });
  });
}

function wranglerTarget() {
  return target === "remote"
    ? ["--remote"]
    : ["--local", "--persist-to", persistPath];
}

async function executeSqlFile(path, capture = false) {
  return command("npx", [
    "wrangler", "d1", "execute", DATABASE,
    "--config", CONFIG,
    ...wranglerTarget(),
    "--file", path,
    "--yes",
    ...(capture ? ["--json"] : []),
  ], { capture });
}

async function executeSql(statement) {
  // Wrangler sends `--file` through D1's import endpoint. That is correct for
  // bulk page imports, but SELECTs return only an import summary instead of
  // the selected rows. Single statements use the query endpoint via
  // `--command`; executeSqlFile remains reserved for bulk page imports.
  return command("npx", [
    "wrangler", "d1", "execute", DATABASE,
    "--config", CONFIG,
    ...wranglerTarget(),
    "--command", statement,
    "--yes",
    "--json",
  ], { capture: true });
}

async function uploadR2(
  key,
  bytes,
  contentType = "application/json; charset=utf-8",
) {
  const directory = await mkdtemp(join(tmpdir(), "bandup-r2-copy-"));
  const path = join(directory, "payload.json");
  try {
    await writeFile(path, bytes, { mode: 0o600 });
    await command("npx", [
      "wrangler", "r2", "object", "put", `${BUCKET}/${key}`,
      "--config", CONFIG,
      target === "remote" ? "--remote" : "--local",
      ...(target === "local" ? ["--persist-to", persistPath] : []),
      "--file", path,
      "--content-type", contentType,
      "--cache-control", "private, max-age=31536000, immutable",
      "--force",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function avatarKind(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: "jpg", contentType: "image/jpeg" };
  }
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e
    && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a
    && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return { extension: "png", contentType: "image/png" };
  }
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46
    && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45
    && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { extension: "webp", contentType: "image/webp" };
  }
  return null;
}

async function sourceAvatar(path, userId) {
  if (typeof path !== "string" || !path) return null;
  const parts = path.split("/");
  if (
    path.length > 500
    || parts.length < 2
    || parts.some((part) => !part || part === "." || part === "..")
    || parts[0] !== userId
  ) {
    die(`avatar path is outside learner ${userId}`);
  }
  const endpoint = `${SOURCE_URL}/storage/v1/object/avatars/${parts.map(encodeURIComponent).join("/")}`;
  let response;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetch(endpoint, {
        headers: {
          apikey: SOURCE_KEY,
          Authorization: `Bearer ${SOURCE_KEY}`,
          Accept: "image/*",
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok || response.status < 500) break;
    } catch {
      response = null;
    }
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  if (!response?.ok) {
    die(`avatar ${path} could not be read from Supabase Storage (${response?.status ?? "network"})`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) {
    die(`avatar ${path} has an invalid size (${bytes.length} bytes)`);
  }
  const kind = avatarKind(bytes);
  if (!kind) die(`avatar ${path} is not a supported JPEG, PNG or WebP image`);
  const digest = hash(bytes);
  const objectKey = `private/avatars/${userId}/${digest}.${kind.extension}`;
  if (!dryRun) {
    await uploadR2(objectKey, bytes, kind.contentType);
    const replay = await readR2(objectKey);
    if (replay.length !== bytes.length || hash(replay) !== digest) {
      die(`avatar ${path} failed R2 checksum verification`);
    }
  }
  avatarSummary.files += 1;
  avatarSummary.bytes += bytes.length;
  return objectKey;
}

async function readR2(key) {
  const directory = await mkdtemp(join(tmpdir(), "bandup-r2-verify-"));
  const path = join(directory, "payload.json");
  try {
    await command("npx", [
      "wrangler", "r2", "object", "get", `${BUCKET}/${key}`,
      "--config", CONFIG,
      target === "remote" ? "--remote" : "--local",
      ...(target === "local" ? ["--persist-to", persistPath] : []),
      "--file", path,
    ]);
    return await readFile(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function persistStored(stored, label) {
  if (!stored?.upload || dryRun) return;
  await uploadR2(stored.objectKey, stored.upload);
  const replay = await readR2(stored.objectKey);
  if (hash(replay) !== stored.digest || replay.length !== stored.bytes) {
    die(`${label} R2 verification failed`);
  }
}

function d1Rows(output) {
  // `npx` can prepend its own non-JSON notice when it resolves Wrangler for a
  // caller outside this repository. Find a complete JSON array, then apply
  // the strict Cloudflare success/result checks below. We never accept a
  // partial or merely JSON-looking response.
  let batches = null;
  for (let start = output.indexOf("["); start !== -1; start = output.indexOf("[", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < output.length; index += 1) {
      const character = output[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') { quoted = true; continue; }
      if (character === "[") depth += 1;
      if (character === "]") {
        depth -= 1;
        if (depth !== 0) continue;
        try {
          const candidate = JSON.parse(output.slice(start, index + 1));
          if (
            Array.isArray(candidate)
            && candidate.length > 0
            && candidate.every(
              (batch) => batch?.success === true && Array.isArray(batch.results),
            )
          ) {
            batches = candidate;
            break;
          }
        } catch {
          // Try the next opening bracket; the strict check below rejects a
          // response that does not contain a valid successful D1 result.
        }
      }
    }
    if (batches) break;
  }
  if (!batches) {
    throw new Error("Cloudflare returned an invalid verification response");
  }
  return batches.flatMap((batch) => Array.isArray(batch.results) ? batch.results : []);
}

function sourceNetworkCode(error) {
  const cause = error && typeof error === "object" && "cause" in error
    ? error.cause
    : null;
  const code = cause && typeof cause === "object" && "code" in cause
    ? cause.code
    : null;
  return typeof code === "string" && /^[A-Z_0-9-]+$/.test(code) ? code : "NETWORK_ERROR";
}

async function fetchSource(endpoint, options, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetch(endpoint, {
        ...options,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 400));
    }
  }
  const host = new URL(SOURCE_URL).hostname;
  throw new Error(
    `${label} could not reach Supabase host ${host} after 3 attempts (${sourceNetworkCode(lastError)}). `
      + "Check SUPABASE_URL, your internet connection, and any VPN/firewall before retrying.",
  );
}

async function sourcePage(table, select, order, offset) {
  const endpoint = new URL(`${SOURCE_URL}/rest/v1/${table}`);
  endpoint.searchParams.set("select", select);
  endpoint.searchParams.set("order", order);
  endpoint.searchParams.set("offset", String(offset));
  endpoint.searchParams.set("limit", String(PAGE_SIZE));
  const response = await fetchSource(endpoint, {
    headers: {
      apikey: SOURCE_KEY,
      Authorization: `Bearer ${SOURCE_KEY}`,
      Accept: "application/json",
    },
  }, `Supabase ${table} page ${offset}`);
  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 404 || detail.includes("PGRST205")) return { absent: true, rows: [] };
    die(`Supabase ${table} page ${offset} failed (${response.status})`);
  }
  const rows = await response.json();
  if (!Array.isArray(rows)) die(`Supabase ${table} returned an invalid page`);
  return { absent: false, rows };
}

async function verifySourceTable(descriptor, expectedTotal) {
  let offset = 0;
  let verified = 0;
  while (true) {
    const page = await sourcePage(
      descriptor.source,
      descriptor.select,
      descriptor.order ?? defaultOrder(descriptor.select),
      offset,
    );
    if (page.absent) {
      if (expectedTotal !== 0) die(`${descriptor.source} disappeared during verification`);
      return;
    }
    if (page.rows.length === 0) break;
    await verifySourceEvidence(descriptor.source, page.rows.map((row) => {
      const sourceId = descriptor.sourceId(row);
      return { sourceId, digest: storedPayload(`migration/source/${descriptor.source}`, sourceId, row).digest };
    }));
    verified += page.rows.length;
    offset += page.rows.length;
    if (page.rows.length < PAGE_SIZE) break;
  }
  if (verified !== expectedTotal) {
    die(`${descriptor.source} changed during copy (${expectedTotal} copied, ${verified} verified)`);
  }
}

function defaultOrder(select) {
  const fields = new Set(select.split(","));
  if (fields.has("id")) return fields.has("created_at") ? "created_at.asc.nullsfirst,id.asc" : "id.asc";
  if (fields.has("created_at")) return "created_at.asc.nullsfirst";
  if (fields.has("recorded_at")) return "recorded_at.asc.nullsfirst";
  return select.split(",")[0] + ".asc";
}

function storedPayload(namespace, owner, value) {
  const raw = JSON.stringify(canonical(value));
  const bytes = Buffer.from(raw);
  if (bytes.length > MAX_JSON_BYTES) die(`${namespace} payload is larger than 2 MB`);
  const digest = hash(bytes);
  return bytes.length <= INLINE_LIMIT
    ? { inline: raw, objectKey: null, digest, bytes: bytes.length, upload: null }
    : {
        inline: null,
        objectKey: `private/${namespace.replaceAll(/[^A-Za-z0-9._/-]/g, "_")}/${owner.replaceAll(/[^A-Za-z0-9._-]/g, "_")}/${digest}.json`,
        digest,
        bytes: bytes.length,
        upload: bytes,
      };
}

function storedObjectPayload(namespace, owner, value) {
  const stored = storedPayload(namespace, owner, value);
  if (stored.objectKey) return stored;
  return {
    ...stored,
    inline: null,
    objectKey: `private/${namespace.replaceAll(/[^A-Za-z0-9._/-]/g, "_")}/${owner.replaceAll(/[^A-Za-z0-9._-]/g, "_")}/${stored.digest}.json`,
    upload: Buffer.from(stored.inline),
  };
}

async function verifySourceEvidence(table, expected) {
  if (expected.length === 0) return;
  const expectedById = new Map(expected.map((item) => [item.sourceId, item]));
  const ids = expected.map((item) => sql(item.sourceId)).join(",");
  const output = await executeSql(`
    SELECT source_id, source_inline, source_object_key, source_sha256, source_bytes
      FROM data_migration_source_rows
     WHERE run_id = ${sql(runId)} AND table_name = ${sql(table)}
       AND source_id IN (${ids})
     ORDER BY source_id;
  `);
  const found = d1Rows(output);

  const foundById = new Map(found.map((row) => [String(row.source_id), row]));
  if (
    found.length !== expected.length
    || foundById.size !== expected.length
    || expected.some((item) => !foundById.has(item.sourceId))
  ) {
    die(`${table} verification count mismatch after retries (${foundById.size}/${expected.length})`);
  }

  for (const [sourceId, item] of expectedById) {
    const row = foundById.get(sourceId);
    let bytes;
    if (typeof row.source_inline === "string") {
      bytes = Buffer.from(row.source_inline);
    } else if (typeof row.source_object_key === "string") {
      bytes = await readR2(row.source_object_key);
    } else {
      die(`${table} verification payload is missing for ${sourceId}`);
    }
    if (
      bytes.length !== Number(row.source_bytes)
      || hash(bytes) !== row.source_sha256
      || row.source_sha256 !== item.digest
    ) {
      die(`${table} verification hash mismatch for ${sourceId}`);
    }
  }
}

const avatarSummary = { files: 0, bytes: 0 };

function subjectUserIds(...values) {
  return [...new Set(values.filter(
    (value) => typeof value === "string" && value.length >= 16 && value.length <= 80,
  ))];
}

function providerEventSubjects(row) {
  const object = row?.payload?.data?.object;
  if (!object || typeof object !== "object") return [];
  const metadata = object.metadata && typeof object.metadata === "object"
    ? object.metadata
    : {};
  return subjectUserIds(metadata.bandup_user_id, object.client_reference_id);
}

function subjectSql(descriptor, row) {
  if (typeof descriptor.subjectUserIdsSql === "function") {
    return descriptor.subjectUserIdsSql(row);
  }
  const subjects = typeof descriptor.subjectUserIds === "function"
    ? descriptor.subjectUserIds(row)
    : [];
  return sql(JSON.stringify(subjectUserIds(...subjects)));
}

const TABLES = [
  {
    source: "profiles",
    target: "app_users+learner_profiles",
    select: "id,email,role,display_name,avatar_path,birth_date,account_kind,created_at,updated_at",
    sourceId: (row) => row.id,
    subjectUserIds: (row) => [row.id],
    async convert(row) {
      const created = iso(row.created_at, new Date(0).toISOString());
      const updated = iso(row.updated_at, created);
      const avatarObjectKey = await sourceAvatar(row.avatar_path, row.id);
      return [
        `INSERT INTO app_users (id,email,role,created_at,updated_at) VALUES (${sql(row.id)},${sql(row.email)},${sql(row.role === "admin" ? "admin" : "user")},${sql(created)},${sql(updated)}) ON CONFLICT(id) DO UPDATE SET email=excluded.email,role=excluded.role,updated_at=excluded.updated_at;`,
        `INSERT INTO learner_profiles (user_id,display_name,birth_date,avatar_object_key,account_kind,source_updated_at,avatar_source_updated_at,updated_at) VALUES (${sql(row.id)},${sql(row.display_name)},${sql(row.birth_date)},${sql(avatarObjectKey)},${sql(row.account_kind)},${sql(updated)},${sql(avatarObjectKey ? updated : null)},${sql(updated)}) ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,birth_date=excluded.birth_date,avatar_object_key=excluded.avatar_object_key,account_kind=excluded.account_kind,source_updated_at=excluded.source_updated_at,avatar_source_updated_at=excluded.avatar_source_updated_at,updated_at=excluded.updated_at;`,
      ];
    },
  },
  {
    source: "app_settings",
    target: "app_settings",
    select: "key,value,updated_at,updated_by",
    order: "key.asc",
    sourceId: (row) => row.key,
    subjectUserIds: (row) => [row.updated_by],
    convert: (row) => {
      const updated = iso(row.updated_at, new Date(0).toISOString());
      return [`INSERT INTO app_settings (key,value_json,source_updated_at,updated_by,mirrored_at) VALUES (${sql(row.key)},${sql(JSON.stringify(row.value))},${sql(updated)},(SELECT id FROM app_users WHERE id=${sql(row.updated_by)}),${sql(updated)}) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,source_updated_at=excluded.source_updated_at,updated_by=excluded.updated_by,mirrored_at=excluded.mirrored_at WHERE excluded.source_updated_at >= app_settings.source_updated_at;`];
    },
  },
  {
    source: "progress_snapshots",
    target: "progress_snapshots",
    select: "user_id,store_key,payload,client_updated_at,created_at,updated_at",
    sourceId: (row) => `${row.user_id}:${row.store_key}`,
    subjectUserIds: (row) => [row.user_id],
    async convert(row) {
      const stored = storedPayload(`progress/${row.store_key}`, row.user_id, row.payload);
      await persistStored(stored, `progress ${row.user_id}:${row.store_key}`);
      const created = iso(row.created_at, new Date(0).toISOString());
      const updated = iso(row.updated_at, created);
      return [`INSERT INTO progress_snapshots (user_id,store_key,payload_inline,payload_object_key,payload_sha256,payload_bytes,client_updated_at,source_updated_at,created_at,updated_at) VALUES (${sql(row.user_id)},${sql(row.store_key)},${sql(stored.inline)},${sql(stored.objectKey)},${sql(stored.digest)},${stored.bytes},${sql(iso(row.client_updated_at))},${sql(updated)},${sql(created)},${sql(updated)}) ON CONFLICT(user_id,store_key) DO UPDATE SET payload_inline=excluded.payload_inline,payload_object_key=excluded.payload_object_key,payload_sha256=excluded.payload_sha256,payload_bytes=excluded.payload_bytes,client_updated_at=excluded.client_updated_at,source_updated_at=excluded.source_updated_at,updated_at=excluded.updated_at;`];
    },
  },
  {
    source: "subscriptions",
    target: "subscriptions",
    select: "id,user_id,provider,status,tier,external_customer_id,external_subscription_id,original_transaction_id,external_price_id,current_period_end,cancel_at_period_end,provider_event_at,verified_at,raw,created_at,updated_at",
    sourceId: (row) => row.id,
    subjectUserIds: (row) => [row.user_id],
    async convert(row) {
      const stored = row.raw === null ? null : storedPayload("subscriptions", row.user_id, row.raw);
      await persistStored(stored, `subscription ${row.id}`);
      const created = iso(row.created_at, new Date(0).toISOString());
      const updated = iso(row.updated_at, created);
      return [`INSERT INTO subscriptions (id,user_id,provider,status,tier,external_customer_id,external_subscription_id,original_transaction_id,external_price_id,current_period_end,cancel_at_period_end,provider_event_at,verified_at,raw_inline,raw_object_key,raw_sha256,created_at,updated_at) VALUES (${sql(row.id)},${sql(row.user_id)},${sql(row.provider)},${sql(row.status)},${sql(row.tier)},${sql(row.external_customer_id)},${sql(row.external_subscription_id)},${sql(row.original_transaction_id)},${sql(row.external_price_id)},${sql(iso(row.current_period_end))},${sql(Boolean(row.cancel_at_period_end))},${sql(iso(row.provider_event_at))},${sql(iso(row.verified_at, updated))},${sql(stored?.inline ?? null)},${sql(stored?.objectKey ?? null)},${sql(stored?.digest ?? null)},${sql(created)},${sql(updated)}) ON CONFLICT(id) DO UPDATE SET status=excluded.status,tier=excluded.tier,current_period_end=excluded.current_period_end,cancel_at_period_end=excluded.cancel_at_period_end,provider_event_at=excluded.provider_event_at,verified_at=excluded.verified_at,raw_inline=excluded.raw_inline,raw_object_key=excluded.raw_object_key,raw_sha256=excluded.raw_sha256,updated_at=excluded.updated_at;`];
    },
  },
  {
    source: "usernames",
    target: "usernames",
    select: "username,user_id,created_at",
    order: "created_at.asc.nullsfirst,username.asc",
    sourceId: (row) => row.username,
    subjectUserIds: (row) => [row.user_id],
    convert: (row) => [`INSERT INTO usernames (username,user_id,created_at,source_updated_at) VALUES (${sql(row.username)},${sql(row.user_id)},${sql(iso(row.created_at,new Date(0).toISOString()))},(SELECT source_updated_at FROM learner_profiles WHERE user_id=${sql(row.user_id)})) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,created_at=excluded.created_at,source_updated_at=excluded.source_updated_at;`],
  },
  {
    source: "provider_events",
    target: "provider_events",
    select: "provider,event_id,received_at,processed_at,payload",
    order: "received_at",
    sourceId: (row) => `${row.provider}:${row.event_id}`,
    subjectUserIds: providerEventSubjects,
    async convert(row) {
      // Provider-event rows are object-only, so even small payloads must be
      // written to private R2 before their D1 pointer is accepted.
      const stored = row.payload === null ? null : storedObjectPayload(`provider-events/${row.provider}`, row.event_id, row.payload);
      await persistStored(stored, `provider event ${row.provider}:${row.event_id}`);
      return [`INSERT INTO provider_events (provider,event_id,received_at,processed_at,payload_object_key,payload_sha256) VALUES (${sql(row.provider)},${sql(row.event_id)},${sql(iso(row.received_at,new Date(0).toISOString()))},${sql(iso(row.processed_at))},${sql(stored?.objectKey ?? null)},${sql(stored?.digest ?? null)}) ON CONFLICT(provider,event_id) DO UPDATE SET processed_at=excluded.processed_at,payload_object_key=excluded.payload_object_key,payload_sha256=excluded.payload_sha256;`];
    },
  },
  {
    source: "usage_events",
    target: "usage_events",
    select: "id,user_id,route,ip_hash,outcome,created_at",
    sourceId: (row) => String(row.id),
    subjectUserIds: (row) => [row.user_id],
    convert: (row) => [`INSERT INTO usage_events (id,user_id,route,ip_hash,outcome,created_at) VALUES (${sql(String(row.id))},${sql(row.user_id)},${sql(row.route)},${sql(row.ip_hash)},${sql(row.outcome)},${sql(iso(row.created_at,new Date(0).toISOString()))}) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,route=excluded.route,ip_hash=excluded.ip_hash,outcome=excluded.outcome,created_at=excluded.created_at;`],
  },
  {
    source: "ai_cost_events",
    target: "ai_cost_events",
    select: "id,source,provider_request_id,external_reference,route,model,input_tokens,output_tokens,cache_creation_input_tokens,cache_creation_5m_input_tokens,cache_creation_1h_input_tokens,cache_read_input_tokens,cost_usd,occurred_at,recorded_at",
    order: "occurred_at",
    sourceId: (row) => String(row.id),
    convert: (row) => [`INSERT INTO ai_cost_events (id,source,provider_request_id,external_reference,route,model,input_tokens,output_tokens,cache_creation_input_tokens,cache_creation_5m_input_tokens,cache_creation_1h_input_tokens,cache_read_input_tokens,cost_usd,occurred_at,recorded_at) VALUES (${sql(String(row.id))},${sql(row.source)},${sql(row.provider_request_id)},${sql(row.external_reference)},${sql(row.route)},${sql(row.model)},${sql(row.input_tokens)},${sql(row.output_tokens)},${sql(row.cache_creation_input_tokens)},${sql(row.cache_creation_5m_input_tokens)},${sql(row.cache_creation_1h_input_tokens)},${sql(row.cache_read_input_tokens)},${sql(String(row.cost_usd))},${sql(iso(row.occurred_at,new Date(0).toISOString()))},${sql(iso(row.recorded_at,new Date(0).toISOString()))}) ON CONFLICT(id) DO UPDATE SET cost_usd=excluded.cost_usd,occurred_at=excluded.occurred_at,recorded_at=excluded.recorded_at;`],
  },
  {
    source: "ai_cost_coverage",
    target: "ai_cost_coverage",
    select: "singleton,source,starts_at,historical_complete,recorded_at",
    order: "recorded_at",
    sourceId: () => "1",
    convert: (row) => [`INSERT INTO ai_cost_coverage (singleton,source,starts_at,historical_complete,recorded_at) VALUES (1,${sql(row.source)},${sql(iso(row.starts_at,new Date(0).toISOString()))},${sql(Boolean(row.historical_complete))},${sql(iso(row.recorded_at,new Date(0).toISOString()))}) ON CONFLICT(singleton) DO UPDATE SET source=excluded.source,starts_at=excluded.starts_at,historical_complete=excluded.historical_complete,recorded_at=excluded.recorded_at;`],
  },
  {
    source: "organization_applications",
    target: "organization_applications",
    select: "id,applicant_user_id,organization_name,purpose,country,contact_email,estimated_students,applicant_role,status,submitted_at,reviewed_at,reviewed_by,review_note,created_at,updated_at",
    sourceId: (row) => row.id,
    subjectUserIds: (row) => [row.applicant_user_id, row.reviewed_by],
    convert: (row) => [`INSERT INTO organization_applications (id,applicant_user_id,organization_name,purpose,country,contact_email,estimated_students,applicant_role,status,submitted_at,reviewed_at,reviewed_by,review_note,created_at,updated_at) VALUES (${sql(row.id)},${sql(row.applicant_user_id ?? "00000000-0000-4000-8000-000000000000")},${sql(row.organization_name)},${sql(row.purpose)},${sql(row.country)},${sql(row.contact_email)},${sql(row.estimated_students)},${sql(row.applicant_role)},${sql(row.status)},${sql(iso(row.submitted_at))},${sql(iso(row.reviewed_at))},${sql(row.reviewed_by)},${sql(row.review_note)},${sql(iso(row.created_at,new Date(0).toISOString()))},${sql(iso(row.updated_at,row.created_at))}) ON CONFLICT(id) DO UPDATE SET status=excluded.status,reviewed_at=excluded.reviewed_at,reviewed_by=excluded.reviewed_by,review_note=excluded.review_note,updated_at=excluded.updated_at;`],
  },
  {
    source: "organizations",
    target: "organizations",
    select: "id,application_id,name,slug,join_code,status,created_by,created_at,updated_at",
    sourceId: (row) => row.id,
    convert: (row) => [`INSERT INTO organizations (id,application_id,name,slug,join_code,status,created_by,created_at,updated_at) VALUES (${sql(row.id)},${sql(row.application_id)},${sql(row.name)},${sql(row.slug)},${sql(row.join_code)},${sql(row.status)},${sql(row.created_by ?? "00000000-0000-4000-8000-000000000000")},${sql(iso(row.created_at,new Date(0).toISOString()))},${sql(iso(row.updated_at,row.created_at))}) ON CONFLICT(id) DO UPDATE SET name=excluded.name,slug=excluded.slug,join_code=excluded.join_code,status=excluded.status,updated_at=excluded.updated_at;`],
  },
  {
    source: "organization_seat_pools",
    target: "organization_seat_pools",
    select: "id,organization_id,provider,external_subscription_id,purchased_seats,status,starts_at,ends_at,created_at,updated_at",
    sourceId: (row) => row.id,
    convert(row) {
      const provider = row.provider === "wechat_pay" ? "wechat" : (row.provider ?? "manual");
      const runtimeStatus = row.status === "past_due" || row.status === "paused" ? "cancelled" : row.status;
      return [`INSERT INTO organization_seat_pools (id,organization_id,provider,external_reference,seat_count,starts_at,ends_at,status,created_at,updated_at,source_provider,source_external_subscription_id,source_purchased_seats,source_status) VALUES (${sql(row.id)},${sql(row.organization_id)},${sql(provider)},${sql(row.external_subscription_id)},${sql(row.purchased_seats)},${sql(iso(row.starts_at))},${sql(iso(row.ends_at))},${sql(runtimeStatus)},${sql(iso(row.created_at,new Date(0).toISOString()))},${sql(iso(row.updated_at,row.created_at))},${sql(row.provider)},${sql(row.external_subscription_id)},${sql(row.purchased_seats)},${sql(row.status)}) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,external_reference=excluded.external_reference,seat_count=excluded.seat_count,starts_at=excluded.starts_at,ends_at=excluded.ends_at,status=excluded.status,updated_at=excluded.updated_at,source_provider=excluded.source_provider,source_external_subscription_id=excluded.source_external_subscription_id,source_purchased_seats=excluded.source_purchased_seats,source_status=excluded.source_status;`];
    },
  },
  {
    source: "organization_memberships",
    target: "organization_memberships",
    select: "id,organization_id,user_id,role,status,share_future_history,share_pre_join_history,joined_at,status_changed_at,created_at,updated_at",
    sourceId: (row) => row.id,
    subjectUserIds: (row) => [row.user_id],
    convert: (row) => [`INSERT INTO organization_memberships (id,organization_id,user_id,role,status,share_future_history,share_pre_join_history,joined_at,status_changed_at,created_at,updated_at) VALUES (${sql(row.id)},${sql(row.organization_id)},${sql(row.user_id)},${sql(row.role)},${sql(row.status)},${sql(Boolean(row.share_future_history))},${sql(Boolean(row.share_pre_join_history))},${sql(iso(row.joined_at))},${sql(iso(row.status_changed_at,row.updated_at))},${sql(iso(row.created_at,new Date(0).toISOString()))},${sql(iso(row.updated_at,row.created_at))}) ON CONFLICT(id) DO UPDATE SET role=excluded.role,status=excluded.status,share_future_history=excluded.share_future_history,share_pre_join_history=excluded.share_pre_join_history,joined_at=excluded.joined_at,status_changed_at=excluded.status_changed_at,updated_at=excluded.updated_at;`],
  },
  {
    source: "teacher_student_assignments",
    target: "teacher_student_assignments",
    select: "id,organization_id,teacher_user_id,student_user_id,assigned_by,created_at,revoked_at,revoked_by",
    sourceId: (row) => row.id,
    subjectUserIds: (row) => [
      row.teacher_user_id, row.student_user_id, row.assigned_by, row.revoked_by,
    ],
    convert: (row) => [`INSERT INTO teacher_student_assignments (id,organization_id,teacher_user_id,student_user_id,assigned_by,created_at,revoked_at,revoked_by) VALUES (${sql(row.id)},${sql(row.organization_id)},${sql(row.teacher_user_id)},${sql(row.student_user_id)},${sql(row.assigned_by)},${sql(iso(row.created_at,new Date(0).toISOString()))},${sql(iso(row.revoked_at))},${sql(row.revoked_by)}) ON CONFLICT(id) DO UPDATE SET assigned_by=excluded.assigned_by,revoked_at=excluded.revoked_at,revoked_by=excluded.revoked_by;`],
  },
  {
    source: "organization_seat_allocations",
    target: "organization_seat_allocations",
    select: "id,organization_id,seat_pool_id,user_id,status,starts_at,ends_at,allocated_by,created_at,updated_at",
    sourceId: (row) => row.id,
    subjectUserIds: (row) => [row.user_id, row.allocated_by],
    convert: (row) => [`INSERT INTO organization_seat_allocations (id,organization_id,seat_pool_id,user_id,status,starts_at,ends_at,allocated_by,created_at,updated_at) VALUES (${sql(row.id)},${sql(row.organization_id)},${sql(row.seat_pool_id)},${sql(row.user_id)},${sql(row.status)},${sql(iso(row.starts_at,new Date(0).toISOString()))},${sql(iso(row.ends_at))},${sql(row.allocated_by)},${sql(iso(row.created_at,new Date(0).toISOString()))},${sql(iso(row.updated_at,row.created_at))}) ON CONFLICT(id) DO UPDATE SET status=excluded.status,starts_at=excluded.starts_at,ends_at=excluded.ends_at,allocated_by=excluded.allocated_by,updated_at=excluded.updated_at;`],
  },
  {
    source: "organization_requests",
    target: "organization_requests",
    select: "id,organization_id,kind,status,requester_user_id,target_user_id,requested_role,requested_value,invitation_email,invitation_token_hash,note,decided_by,decided_at,created_at,updated_at",
    sourceId: (row) => row.id,
    subjectUserIds: (row) => [row.requester_user_id, row.target_user_id, row.decided_by],
    convert: (row) => [`INSERT INTO organization_requests (id,organization_id,kind,status,requester_user_id,target_user_id,requested_role,requested_value,invitation_email,invitation_token_hash,note,expires_at,decided_by,decided_at,created_at,updated_at) VALUES (${sql(row.id)},${sql(row.organization_id)},${sql(row.kind)},${sql(row.status)},${sql(row.requester_user_id)},${sql(row.target_user_id)},${sql(row.requested_role)},${row.requested_value === null ? "NULL" : sql(Boolean(row.requested_value))},${sql(row.invitation_email)},${sql(row.invitation_token_hash)},${sql(row.note)},${sql(row.kind === "invitation" ? new Date(Date.parse(row.created_at) + 14 * 86_400_000).toISOString() : null)},${sql(row.decided_by)},${sql(iso(row.decided_at))},${sql(iso(row.created_at,new Date(0).toISOString()))},${sql(iso(row.updated_at,row.created_at))}) ON CONFLICT(id) DO UPDATE SET status=excluded.status,target_user_id=excluded.target_user_id,requested_role=excluded.requested_role,requested_value=excluded.requested_value,note=excluded.note,expires_at=excluded.expires_at,decided_by=excluded.decided_by,decided_at=excluded.decided_at,updated_at=excluded.updated_at;`],
  },
  {
    source: "practice_attempts",
    target: "practice_attempts",
    select: "id,user_id,source_key,module,test_id,test_title,band,raw_score,score_out_of,submitted_at,payload,created_at,updated_at",
    sourceId: (row) => row.id,
    subjectUserIds: (row) => [row.user_id],
    async convert(row) {
      const stored = storedPayload(`attempts/${row.module}`, row.id, row.payload);
      await persistStored(stored, `practice attempt ${row.id}`);
      const resultHasReview = Boolean(
        row.payload
          && typeof row.payload === "object"
          && row.payload.review
          && typeof row.payload.review === "object",
      );
      return [`INSERT INTO practice_attempts (id,user_id,source_key,module,test_id,test_title,submitted_at,score,score_out_of,band,result_inline,result_object_key,result_sha256,result_bytes,result_has_review,created_at,updated_at) VALUES (${sql(row.id)},${sql(row.user_id)},${sql(row.source_key)},${sql(row.module)},${sql(row.test_id)},${sql(row.test_title)},${sql(iso(row.submitted_at,new Date(0).toISOString()))},${sql(row.raw_score)},${sql(row.score_out_of)},${sql(row.band)},${sql(stored.inline)},${sql(stored.objectKey)},${sql(stored.digest)},${stored.bytes},${sql(resultHasReview)},${sql(iso(row.created_at,new Date(0).toISOString()))},${sql(iso(row.updated_at,row.created_at))}) ON CONFLICT(id) DO UPDATE SET source_key=excluded.source_key,test_title=excluded.test_title,submitted_at=excluded.submitted_at,score=excluded.score,score_out_of=excluded.score_out_of,band=excluded.band,result_inline=CASE WHEN practice_attempts.result_has_review=1 AND excluded.result_has_review=0 THEN practice_attempts.result_inline ELSE excluded.result_inline END,result_object_key=CASE WHEN practice_attempts.result_has_review=1 AND excluded.result_has_review=0 THEN practice_attempts.result_object_key ELSE excluded.result_object_key END,result_sha256=CASE WHEN practice_attempts.result_has_review=1 AND excluded.result_has_review=0 THEN practice_attempts.result_sha256 ELSE excluded.result_sha256 END,result_bytes=CASE WHEN practice_attempts.result_has_review=1 AND excluded.result_has_review=0 THEN practice_attempts.result_bytes ELSE excluded.result_bytes END,result_has_review=max(practice_attempts.result_has_review,excluded.result_has_review),updated_at=excluded.updated_at;`];
    },
  },
  {
    source: "organization_attempt_archives",
    target: "organization_attempt_archives",
    select: "organization_id,attempt_id,archived_by,archived_at,reason,restored_by,restored_at",
    order: "archived_at",
    sourceId: (row) => `${row.organization_id}:${row.attempt_id}`,
    subjectUserIdsSql: (row) => `coalesce((select json_array(user_id,${sql(row.archived_by)},${sql(row.restored_by)}) from practice_attempts where id=${sql(row.attempt_id)}),${sql(JSON.stringify(subjectUserIds(row.archived_by, row.restored_by)))})`,
    convert: (row) => [`INSERT INTO organization_attempt_archives (organization_id,attempt_id,archived_by,archived_at,reason,restored_by,restored_at) VALUES (${sql(row.organization_id)},${sql(row.attempt_id)},${sql(row.archived_by)},${sql(iso(row.archived_at,new Date(0).toISOString()))},${sql(row.reason)},${sql(row.restored_by)},${sql(iso(row.restored_at))}) ON CONFLICT(organization_id,attempt_id) DO UPDATE SET archived_by=excluded.archived_by,archived_at=excluded.archived_at,reason=excluded.reason,restored_by=excluded.restored_by,restored_at=excluded.restored_at;`],
  },
  {
    source: "organization_attempt_tombstones",
    target: "organization_attempt_tombstones",
    select: "organization_id,attempt_id,removed_by,removed_at,reason",
    order: "removed_at",
    sourceId: (row) => `${row.organization_id}:${row.attempt_id}`,
    convert: (row) => [`INSERT OR IGNORE INTO organization_attempt_tombstones (organization_id,attempt_id,student_user_id,removed_by,reason,removed_at) VALUES (${sql(row.organization_id)},${sql(row.attempt_id)},NULL,${sql(row.removed_by)},${sql(row.reason)},${sql(iso(row.removed_at,new Date(0).toISOString()))});`],
  },
  {
    source: "organization_audit_log",
    target: "organization_audit_log",
    select: "id,organization_id,actor_user_id,action,target_user_id,entity_type,entity_id,details,created_at",
    sourceId: (row) => String(row.id),
    convert: (row) => [`INSERT OR IGNORE INTO organization_audit_log (id,organization_id,actor_user_id,action,target_type,target_id,metadata_json,created_at,target_user_id,entity_type,entity_id,source_details_json) VALUES (${sql(String(row.id))},${sql(row.organization_id)},${sql(row.actor_user_id ?? "00000000-0000-4000-8000-000000000000")},${sql(row.action)},${sql(row.entity_type)},${sql(row.entity_id)},${sql(JSON.stringify(row.details ?? {}))},${sql(iso(row.created_at,new Date(0).toISOString()))},${sql(row.target_user_id)},${sql(row.entity_type)},${sql(row.entity_id)},${sql(JSON.stringify(row.details ?? {}))});`],
  },
  {
    source: "organization_command_receipts",
    target: "organization_command_receipts",
    select: "actor_user_id,idempotency_key,action,request_hash,response,created_at",
    order: "created_at.asc.nullsfirst,actor_user_id.asc,idempotency_key.asc",
    sourceId: (row) => `${row.actor_user_id}:${row.idempotency_key}`,
    subjectUserIds: (row) => [row.actor_user_id],
    convert: (row) => [`INSERT OR IGNORE INTO organization_command_receipts (actor_user_id,idempotency_key,action,response_json,created_at,request_hash) VALUES (${sql(row.actor_user_id)},${sql(row.idempotency_key)},${sql(row.action)},${sql(JSON.stringify(row.response))},${sql(iso(row.created_at,new Date(0).toISOString()))},${sql(row.request_hash)});`],
  },
  {
    source: "organization_sync_receipts",
    target: "organization_sync_receipts",
    select: "actor_user_id,idempotency_key,request_hash,response,created_at",
    order: "created_at.asc.nullsfirst,actor_user_id.asc,idempotency_key.asc",
    sourceId: (row) => `${row.actor_user_id}:${row.idempotency_key}`,
    subjectUserIds: (row) => [row.actor_user_id],
    convert: (row) => {
      const count = Number(row.response?.synced ?? row.response?.attemptCount ?? 0);
      return [`INSERT OR IGNORE INTO organization_sync_receipts (user_id,idempotency_key,attempt_count,created_at,request_hash,response_json) VALUES (${sql(row.actor_user_id)},${sql(row.idempotency_key)},${Number.isInteger(count) && count >= 0 ? count : 0},${sql(iso(row.created_at,new Date(0).toISOString()))},${sql(row.request_hash)},${sql(JSON.stringify(row.response))});`];
    },
  },
];

const runId = randomUUID();
const startedAt = new Date().toISOString();
const sourceProjectHash = hash(new URL(SOURCE_URL).hostname);
const mode = dryRun ? "dry-run" : "copy";

async function recordRun(status, summary = null, errorCode = null) {
  if (dryRun) return;
  const sqlText = status === "running"
    ? `INSERT INTO data_migration_runs (id,source_system,target_system,mode,status,started_at,source_project_hash) VALUES (${sql(runId)},'supabase','cloudflare-d1-r2',${sql(mode)},'running',${sql(startedAt)},${sql(sourceProjectHash)});`
    : `UPDATE data_migration_runs SET status=${sql(status)},completed_at=${sql(new Date().toISOString())},summary_json=${sql(summary ? JSON.stringify(summary) : null)},error_code=${sql(errorCode)} WHERE id=${sql(runId)};`;
  await executeSql(sqlText);
}

const summary = {
  runId,
  target,
  targetEnvironment: productionTarget ? "production" : "preview",
  dryRun,
  startedAt,
  tables: {},
  avatars: avatarSummary,
};

try {
  migrationRunStarted = true;
  await recordRun("running");
  if (!dryRun) {
    await executeSql(`INSERT OR IGNORE INTO app_users (id,email,role,created_at,updated_at,deleted_at) VALUES ('00000000-0000-4000-8000-000000000000',NULL,'user','1970-01-01T00:00:00.000Z','1970-01-01T00:00:00.000Z','1970-01-01T00:00:00.000Z');`);
  }
  for (const descriptor of TABLES) {
    let offset = 0;
    let total = 0;
    let absent = false;
    while (true) {
      const page = await sourcePage(
        descriptor.source,
        descriptor.select,
        descriptor.order ?? defaultOrder(descriptor.select),
        offset,
      );
      if (page.absent) { absent = true; break; }
      if (page.rows.length === 0) break;
      const pageHash = hash(page.rows);
      const statements = [];
      const rowMaps = [];
      const sourceEvidence = [];
      const expectedEvidence = [];
      for (const row of page.rows) {
        const converted = await descriptor.convert(row);
        statements.push(...converted);
        const sourceId = descriptor.sourceId(row);
        const sourceStored = storedPayload(`migration/source/${descriptor.source}`, sourceId, row);
        await persistStored(sourceStored, `${descriptor.source} source ${sourceId}`);
        const subjects = subjectSql(descriptor, row);
        sourceEvidence.push(`INSERT INTO data_migration_source_rows (run_id,table_name,source_id,source_inline,source_object_key,source_sha256,source_bytes,recorded_at,subject_user_ids_json) VALUES (${sql(runId)},${sql(descriptor.source)},${sql(sourceId)},${sql(sourceStored.inline)},${sql(sourceStored.objectKey)},${sql(sourceStored.digest)},${sourceStored.bytes},${sql(new Date().toISOString())},${subjects});`);
        expectedEvidence.push({ sourceId, digest: sourceStored.digest });
        rowMaps.push(`INSERT INTO data_migration_row_map (run_id,table_name,source_id,target_id,row_sha256,recorded_at,subject_user_ids_json) VALUES (${sql(runId)},${sql(descriptor.source)},${sql(sourceId)},${sql(sourceId)},${sql(hash(row))},${sql(new Date().toISOString())},${subjects});`);
      }
      if (!dryRun) {
        const directory = await mkdtemp(join(tmpdir(), "bandup-d1-page-"));
        const path = join(directory, "page.sql");
        try {
          await writeFile(path, `${statements.join("\n")}\n${sourceEvidence.join("\n")}\n${rowMaps.join("\n")}\n`, { mode: 0o600 });
          await executeSqlFile(path);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
        await verifySourceEvidence(descriptor.source, expectedEvidence);
        await executeSql(`INSERT INTO data_migration_checkpoints (run_id,table_name,source_cursor,source_count,copied_count,verified_count,checksum,recorded_at) VALUES (${sql(runId)},${sql(descriptor.source)},${sql(String(offset))},${page.rows.length},${page.rows.length},${page.rows.length},${sql(pageHash)},${sql(new Date().toISOString())});`);
      }
      total += page.rows.length;
      offset += page.rows.length;
      if (page.rows.length < PAGE_SIZE) break;
    }
    if (!dryRun && !absent) await verifySourceTable(descriptor, total);
    summary.tables[descriptor.source] = { target: descriptor.target, rows: total, absent };
    process.stdout.write(`${descriptor.source}: ${absent ? "not installed" : `${total} rows ${dryRun ? "validated" : "copied"}`}\n`);
  }
  summary.completedAt = new Date().toISOString();
  await recordRun("complete", summary);
  process.stdout.write(`${dryRun ? "Dry run" : "Copy"} complete. Run id: ${runId}\n`);
} catch (error) {
  summary.failedAt = new Date().toISOString();
  summary.error = error instanceof Error ? error.message.slice(0, 500) : "unknown";
  await recordRun("failed", summary, "COPY_FAILED").catch(() => undefined);
  process.stderr.write(`Migration stopped: ${summary.error}\n`);
  process.exitCode = 1;
}
