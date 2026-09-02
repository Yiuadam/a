import { roundToHalf } from "@/lib/band";
import type { MockExamReport, MockRetake, ModuleName } from "@/lib/types";

/*
  The learner's standing Test Report Form, and how a retaken skill changes it.

  ---------------------------------------------------------------------------
  What IELTS actually does, and what this copies

  One Skill Retake is a real thing rather than a convenience this app invented.
  A candidate who has sat a full computer-delivered test may book a retake of a
  single skill — Listening, Reading, Writing or Speaking — and sit that skill
  on its own. What they receive is a *new Test Report Form* carrying the new
  score for the skill they re-sat and the original scores for the other three,
  with the retaken score marked as a retake. The overall band is recalculated
  from those four numbers by the ordinary rule, the mean rounded to the nearest
  half band.

  The detail that decides this file's shape is what happens to the first form:
  nothing. The original Test Report Form remains valid, and the candidate
  chooses which of the two to send. A retake does not overwrite a sitting; it
  issues a second document alongside it.

  So a retake here is recorded as its own row, never written back over the
  sitting it updates. `MockExamReport` stays exactly what it always was — the
  bands somebody earned in one three-hour sitting, immutable — and the standing
  form is *derived*: the sitting, with each module replaced by the most recent
  retake of that module against it. Nothing a learner earned is ever lost or
  edited, which is the property that matters most when the alternative is a
  band quietly disappearing.

  ---------------------------------------------------------------------------
  Why the derived overall is still null unless all four are marked

  lib/exam/mock.ts withholds the overall whenever a module is unmarked, on the
  grounds that a mean of two modules is not an overall band and a learner shown
  one would carry it away as though it were. That reasoning does not weaken
  here; it applies to a form assembled from a sitting and a retake exactly as
  it applies to a form assembled from a sitting alone, because the number means
  the same thing in both and would be quoted the same way. `overallBand` below
  is the single implementation of that rule, and `overallFrom` in mock.ts calls
  it rather than keeping a second copy.

  It has one consequence worth naming, and it is a good one. A sitting whose
  Writing could not be marked has no overall band at all. Retake Writing on a
  plan that can mark it and the fourth number arrives, so the overall appears
  for the first time — from the same rule, with no special case. The reverse
  cannot happen: a retake that could not be marked is never recorded (see
  recordRetake in lib/exam/mock.ts), so it can never take a standing band away.
*/

/**
 * The four skills, in the order a candidate meets them.
 *
 * Declared here rather than in lib/exam/mock.ts, which is where it used to
 * live, because this module is the light one: it imports a rounding function
 * and some types, where mock.ts pulls in every reading passage and listening
 * script the app ships. The history page needs the order and the arithmetic and
 * must not pay a megabyte of question banks for them. mock.ts re-exports this
 * as `MOCK_MODULES`, so there is still one declaration.
 */
export const REPORT_MODULES = ["listening", "reading", "writing", "speaking"] as const;

/** One skill's standing band, and where it came from. */
export interface StandingModule {
  module: ModuleName;
  /** null when this skill has never been marked, in the sitting or since. */
  band: number | null;
  raw?: number;
  total?: number;
  /**
   * The sitting's own band, kept beside the standing one whenever a retake has
   * replaced it, and null otherwise.
   *
   * Visible on purpose. A learner tracking progress wants to see that Listening
   * went 6.0 to 7.0, and would be poorly served by a record that showed only
   * the 7.0 — but they are worse served by one that hides a retake which went
   * the other way. Both directions are shown for the same reason: the standing
   * band is what you would score today, and the original is what you scored,
   * and neither is allowed to erase the other.
   */
  original: number | null;
  /** When the band now standing was earned. */
  at: string;
  /** How many times this skill has been re-sat against this sitting. */
  retakes: number;
}

/** A sitting plus its retakes, resolved into the form that stands today. */
export interface StandingRecord {
  /** The `MockExamReport` this form is built on. */
  reportId: string;
  /** When the original sitting was completed. */
  satAt: string;
  /** When the form last changed — the sitting, or its most recent retake. */
  issuedAt: string;
  modules: StandingModule[];
  overall: number | null;
  /** Skills with no band at all, for the page to name rather than imply. */
  unmarked: ModuleName[];
  /** Every retake against this sitting, newest first. */
  history: MockRetake[];
}

/**
 * The mean of the four module bands, to the nearest half — or null.
 *
 * Written over the four named skills rather than over whatever array it is
 * handed, which is not fussiness. The rule being enforced is "all four, or
 * nothing", and a version that summed an array and divided by its length would
 * happily return a confident number for three modules if a caller ever built
 * the array from a filter. Here a missing skill is a missing key, and a missing
 * key is null; there is no arrangement of the input that produces a band from
 * fewer than four.
 *
 * The rounding is `roundToHalf`, which is the official rule — .25 up and .75 up
 * — already written for the placement test and already tested.
 */
export function overallBand(
  bands: Partial<Record<ModuleName, number | null | undefined>>,
): number | null {
  let sum = 0;
  for (const skill of REPORT_MODULES) {
    const band = bands[skill];
    if (typeof band !== "number" || !Number.isFinite(band)) return null;
    sum += band;
  }
  return roundToHalf(sum / REPORT_MODULES.length);
}

function isModule(value: unknown): value is ModuleName {
  return REPORT_MODULES.includes(value as (typeof REPORT_MODULES)[number]);
}

function isBand(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/*
  A retake read back out of storage has been through JSON and possibly through
  a sync with a device running a different build, so nothing about its shape is
  guaranteed. Anything that fails this is dropped rather than repaired: a
  half-understood retake that replaced a real band with a guess would be the one
  outcome worse than not showing a retake at all.
*/
function usable(retake: MockRetake | null | undefined): retake is MockRetake {
  return (
    !!retake &&
    typeof retake.of === "string" &&
    isModule(retake.module) &&
    isBand(retake.band) &&
    typeof retake.completedAt === "string" &&
    Number.isFinite(Date.parse(retake.completedAt))
  );
}

/** Every valid retake against one sitting, newest first. */
export function retakesOf(
  reportId: string,
  retakes: readonly MockRetake[] | null | undefined,
): MockRetake[] {
  return (retakes ?? [])
    .filter(usable)
    .filter((retake) => retake.of === reportId)
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));
}

/**
 * Resolve one sitting and its retakes into the Test Report Form that stands.
 *
 * The most recent retake of a skill wins, not the best one. Best-wins would
 * make the standing band a personal record rather than a measurement, and this
 * number is the one a learner uses to decide whether they are ready to book the
 * real test — a figure that can only ever go up is exactly the wrong thing to
 * make that decision on. The sitting's own band stays visible beside it either
 * way, so a retake that went down is recorded honestly rather than hidden.
 */
export function standingFor(
  report: MockExamReport,
  retakes: readonly MockRetake[] | null | undefined,
): StandingRecord {
  const history = retakesOf(report.id, retakes);

  const modules: StandingModule[] = REPORT_MODULES.map((skill) => {
    const sat = report.marks[skill];
    const original = sat && isBand(sat.band) ? sat.band : null;
    const mine = history.filter((retake) => retake.module === skill);
    const latest = mine[0];

    if (!latest) {
      return {
        module: skill,
        band: original,
        raw: sat?.raw,
        total: sat?.total,
        original: null,
        at: report.completedAt,
        retakes: 0,
      };
    }

    return {
      module: skill,
      band: latest.band,
      raw: latest.raw,
      total: latest.total,
      original,
      at: latest.completedAt,
      retakes: mine.length,
    };
  });

  const bands: Partial<Record<ModuleName, number | null>> = {};
  for (const entry of modules) bands[entry.module] = entry.band;

  /*
    The form's date is the latest thing on it. A learner who retook Listening
    this morning is looking at a report issued this morning, not at one dated
    to a sitting three weeks ago — which is what the real retake does too, by
    issuing a new form rather than amending the old one.
  */
  const issuedAt = history[0]
    ? (history[0].completedAt > report.completedAt ? history[0].completedAt : report.completedAt)
    : report.completedAt;

  return {
    reportId: report.id,
    satAt: report.completedAt,
    issuedAt,
    modules,
    overall: overallBand(bands),
    unmarked: modules.filter((entry) => entry.band === null).map((entry) => entry.module),
    history,
  };
}

/**
 * The sitting a learner's standing record is built on: the most recent one.
 *
 * By date rather than by position, for the reason lib/results.ts sets out at
 * length — the array is built newest-first in one place and unioned in another,
 * and a reader that trusts position has already been wrong here once.
 *
 * A newer full sitting supersedes an older one entirely, retakes and all. That
 * is the real rule as well: a retake belongs to the test it was booked against,
 * and sitting a fresh full test issues a fresh form with nothing carried over.
 * The older sitting and its retakes are not deleted — they stay in the archive,
 * and every band either produced is still in the learner's results.
 */
export function currentSitting(
  reports: readonly MockExamReport[] | null | undefined,
): MockExamReport | null {
  let best: MockExamReport | null = null;
  for (const report of reports ?? []) {
    if (!report || typeof report.completedAt !== "string" || !report.marks) continue;
    if (!best || report.completedAt > best.completedAt) best = report;
  }
  return best;
}

/** The standing Test Report Form, or null when no full sitting has been made. */
export function standingRecord(
  reports: readonly MockExamReport[] | null | undefined,
  retakes: readonly MockRetake[] | null | undefined,
): StandingRecord | null {
  const report = currentSitting(reports);
  return report ? standingFor(report, retakes) : null;
}
