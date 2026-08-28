#!/usr/bin/env node

/*
  Sends a local, confidential Supabase Auth bcrypt export to the owner-only
  Cloudflare importer one record at a time. It prints aggregate progress only;
  no email, user id or verifier is placed in output, request URLs or shell
  arguments. The bearer token is read from an environment variable rather than
  the command line so it is not placed in shell history.
*/

import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
register("./ts-resolve.mjs", import.meta.url);
const { isAcceptedBcryptVerifier } = await import(
  pathToFileURL(join(ROOT, "lib", "auth", "bcrypt-verifier.ts")).href
);
const { passwordProofManifest } = await import(
  pathToFileURL(join(ROOT, "lib", "cloudflare", "native-password-proof.ts")).href
);

function usage() {
  return "Usage: BANDUP_MIGRATION_BEARER_TOKEN=… node scripts/import-native-password-credentials.mjs --input /secure/export.jsonl --origin https://organization-preview.bandup.life";
}

function outsideRepository(value, label) {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path outside the repository`);
  const resolved = resolve(value);
  const pathFromRoot = relative(ROOT, resolved);
  if (pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))) {
    throw new Error(`${label} must be outside the repository`);
  }
  return resolved;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function importedRow(value, line) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`line ${line} must be a JSON object`);
  }
  const row = value;
  const userId = typeof row.id === "string" ? row.id.trim() : "";
  const email = typeof row.email === "string" ? row.email.trim().toLowerCase() : "";
  const verifier = typeof row.encrypted_password === "string" ? row.encrypted_password : "";
  if (userId.length < 16 || userId.length > 80) throw new Error(`line ${line} has an invalid user id`);
  if (!email || email.length > 254 || !email.includes("@")) throw new Error(`line ${line} has an invalid email`);
  if (!isAcceptedBcryptVerifier(verifier)) throw new Error(`line ${line} is not an accepted bcrypt verifier`);
  return { userId, email, verifier, sourceUpdatedAt: timestamp(row.updated_at, `line ${line} updated_at`) };
}

export function parsePasswordExport(source) {
  const rows = [];
  const ids = new Set();
  const emails = new Set();
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`line ${index + 1} is not valid JSON`);
    }
    const row = importedRow(value, index + 1);
    if (ids.has(row.userId)) throw new Error(`line ${index + 1} duplicates a user id`);
    if (emails.has(row.email)) throw new Error(`line ${index + 1} duplicates an email`);
    ids.add(row.userId);
    emails.add(row.email);
    rows.push(row);
  }
  if (rows.length === 0) throw new Error("the export contains no password credentials");
  return rows;
}

function parseArgs(argv) {
  let input = null;
  let origin = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag === "--input" || flag === "--origin") && value) {
      if (flag === "--input") input = value;
      else origin = value;
      index += 1;
    } else {
      throw new Error(usage());
    }
  }
  if (!input || !origin) throw new Error(usage());
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("origin must be one HTTPS origin without a path");
  }
  return { input: outsideRepository(input, "input"), origin: url.origin };
}

async function main() {
  const token = process.env.BANDUP_MIGRATION_BEARER_TOKEN;
  if (!token || token.length > 16_384) throw new Error("BANDUP_MIGRATION_BEARER_TOKEN must contain a current owner session token");
  const { input, origin } = parseArgs(process.argv.slice(2));
  const rows = parsePasswordExport(await readFile(input, "utf8"));
  const sourceManifestSha256 = await passwordProofManifest(rows);
  if (!sourceManifestSha256) throw new Error("the export could not be committed for an exact password migration check");
  let stored = 0;
  let alreadyNewer = 0;
  for (const credential of rows) {
    const response = await fetch(`${origin}/api/admin/cloudflare/password-import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true, credential }),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`import stopped after ${stored + alreadyNewer} record(s); the service rejected a record without importing it`);
    }
    const result = await response.json().catch(() => null);
    if (!result || result.processed !== 1 || !Number.isInteger(result.stored) || !Number.isInteger(result.alreadyNewer)) {
      throw new Error("the service returned an invalid import receipt");
    }
    stored += result.stored;
    alreadyNewer += result.alreadyNewer;
  }
  const receipt = await fetch(`${origin}/api/admin/cloudflare/password-import/proof`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      confirm: true,
      sourceRows: rows.length,
      sourceManifestSha256,
    }),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!receipt.ok) {
    throw new Error("all password verifiers were imported, but the exact source-to-D1 certificate was not recorded");
  }
  const proof = await receipt.json().catch(() => null);
  if (!proof || proof.verified !== true || proof.sourceRows !== rows.length || proof.importedRows !== rows.length) {
    throw new Error("the service returned an invalid aggregate password-import certificate");
  }
  process.stdout.write(`Imported ${stored} encrypted password verifier${stored === 1 ? "" : "s"}; ${alreadyNewer} already had an equal or newer verifier. Exact source-to-D1 certificate: verified.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
