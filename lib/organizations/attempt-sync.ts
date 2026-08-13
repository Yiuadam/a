import type { ModuleResult } from "@/lib/types";

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  return Number.isFinite(Date.parse(value));
}

/**
 * Keep arbitrary profile JSON out of the normalized attempt ledger. Detailed
 * review objects are retained, but only a bounded recognisable ModuleResult
 * can enter either the immediate sync path or its durable outbox.
 */
export function organizationAttempts(value: unknown): ModuleResult[] {
  if (!Array.isArray(value)) return [];
  const modules = new Set(["listening", "reading", "writing", "speaking"]);
  return value.slice(0, 100).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const result = entry as Partial<ModuleResult>;
    if (!modules.has(String(result.module))) return [];
    if (typeof result.testId !== "string" || result.testId.length === 0 || result.testId.length > 180) return [];
    if (typeof result.testTitle !== "string" || result.testTitle.length === 0 || result.testTitle.length > 600) return [];
    if (typeof result.band !== "number" || !Number.isFinite(result.band) || result.band < 0 || result.band > 9) return [];
    if (!validDate(result.date)) return [];
    // Dates are part of the deterministic source key and are compared by D1.
    // Persist one canonical representation so equivalent offsets cannot create
    // duplicate attempts and SQLite never has to interpret a loose date form.
    return [{ ...result, date: new Date(result.date).toISOString() } as ModuleResult];
  });
}

/** Normalize a learner history-clear tombstone for lexicographic D1 storage. */
export function organizationHistoryClearWatermark(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as { historyClearedAt?: unknown }).historyClearedAt;
  if (!validDate(candidate)) return null;
  return new Date(candidate).toISOString();
}

/** A missing review is a score-only payload; an object is durable detail. */
export function organizationAttemptHasReview(result: ModuleResult): boolean {
  return Boolean(result.review && typeof result.review === "object");
}
