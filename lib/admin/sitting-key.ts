import type { ModuleResult } from "@/lib/types";

type SittingIdentity = Pick<ModuleResult, "module" | "testId" | "date">;

/** A stable route key; array order changes cannot open a different sitting. */
export function adminSittingKey(result: SittingIdentity): string {
  return encodeURIComponent(JSON.stringify([result.module, result.testId, result.date]));
}

export function findAdminSitting(results: readonly ModuleResult[], routeKey: string): ModuleResult | null {
  let decoded: unknown;
  try {
    // Next route params are normally already URL-decoded. Parse that value
    // first so literal percent signs remain exact; retain one decoded fallback
    // for direct callers and older links.
    decoded = JSON.parse(routeKey);
  } catch {
    try {
      decoded = JSON.parse(decodeURIComponent(routeKey));
    } catch {
      return null;
    }
  }
  if (
    !Array.isArray(decoded)
    || decoded.length !== 3
    || decoded.some((value) => typeof value !== "string")
  ) return null;
  const [module, testId, date] = decoded as [string, string, string];
  return results.find((result) =>
    result.module === module && result.testId === testId && result.date === date
  ) ?? null;
}
