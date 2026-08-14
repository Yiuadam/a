import { createHash } from "node:crypto";

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]),
  );
}

export function json(value) {
  return JSON.stringify(canonical(value));
}

export function hash(value) {
  const input = value instanceof Uint8Array
    ? value
    : (typeof value === "string" ? value : json(value));
  return createHash("sha256").update(input).digest("hex");
}
