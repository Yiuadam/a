import type { ModuleResult } from "@/lib/types";
import type { StudentHistoryAttempt } from "./types";

const RESULT_MODULES = new Set(["listening", "reading", "writing", "speaking"]);

export function organizationAttemptResult(attempt: StudentHistoryAttempt): ModuleResult | null {
  if (!RESULT_MODULES.has(attempt.skill)) return null;
  if (typeof attempt.band !== "number" || !Number.isFinite(attempt.band) || attempt.band < 0 || attempt.band > 9) return null;
  return {
    module: attempt.skill as ModuleResult["module"],
    testId: attempt.id,
    testTitle: attempt.title,
    band: attempt.band,
    ...(attempt.score !== null ? { raw: attempt.score } : {}),
    ...(attempt.scoreOutOf !== null ? { total: attempt.scoreOutOf } : {}),
    date: attempt.submittedAt,
    ...(attempt.review ? { review: attempt.review } : {}),
  };
}
