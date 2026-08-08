import type { ModuleName, Profile } from "./types";
import { latestFor } from "./results";

export interface PlanTask {
  label: string;
  href: string;
}

/**
 * One stretch of the plan: a run of days with a single module to work on.
 *
 * This was `PlanWeek` for as long as every plan was four weeks long, and the
 * page numbered the weeks itself. Now that the learner picks the window a
 * stretch can be six days or one, so it carries its own `label` — "Week 2",
 * "Days 3–4", "Day 5" — and the page prints whatever it is given rather than
 * wording a length it would have to work out.
 */
export interface PlanBlock {
  /** Position in the plan, counting from one. The numbered bubble on screen. */
  step: number;
  label: string;
  /** How many days of the window this block covers. */
  days: number;
  focus: string;
  rationale: string;
  tasks: PlanTask[];
}

export interface StudyPlan {
  currentBand: number;
  targetBand: number;
  gap: number;
  /** The window this plan covers, already resolved to one the menu offers. */
  duration: PlanDuration;
  headline: string;
  /** How often to sit down, worded for the window that was chosen. */
  rhythm: string;
  blocks: PlanBlock[];
  weakSkills: string[];
}

/**
 * One length the learner can choose, written out three ways.
 *
 * Three, because English will not let one string stand in every slot: "2 weeks"
 * belongs in the menu, "2-week" in front of a noun, and "the next two weeks"
 * inside a sentence. Any of them dropped into the wrong slot gives "Your 5 days
 * study plan" or "Use 5 days to keep all four skills sharp", and broken English
 * on an app that teaches English is not a cosmetic bug. Writing all three by
 * hand also lets the prose spell its numbers out, which reads warmer.
 */
export interface PlanDuration {
  days: number;
  /** The menu entry. Short, so the whole list can be read at a glance. */
  label: string;
  /** In front of a noun: "Your 2-week study plan". */
  heading: string;
  /** Inside a sentence: "Focused work over the next two weeks". */
  phrase: string;
}

/*
  The lengths on offer.

  Five days is the shortest because the plan gives each of the four modules its
  own stretch, and below five days some module would get no day at all — a plan
  that quietly skips speaking is worse than no plan. Four weeks is the longest
  because it is the cycle the app was built around: work the plan, retake the
  placement test, start again on whatever you are weakest at now.
*/
const FOUR_WEEKS: PlanDuration = {
  days: 28,
  label: "4 weeks",
  heading: "4-week",
  phrase: "the next four weeks",
};

export const PLAN_DURATIONS: readonly PlanDuration[] = [
  { days: 5, label: "5 days", heading: "5-day", phrase: "the next five days" },
  { days: 7, label: "1 week", heading: "1-week", phrase: "the next week" },
  { days: 14, label: "2 weeks", heading: "2-week", phrase: "the next two weeks" },
  { days: 21, label: "3 weeks", heading: "3-week", phrase: "the next three weeks" },
  FOUR_WEEKS,
];

/** Four weeks — the length every plan was before the learner could choose. */
export const DEFAULT_PLAN_DAYS = FOUR_WEEKS.days;

/**
 * The stored window, turned into one of the lengths actually on offer.
 *
 * Nothing outside the menu should reach the plan builder, and the stored number
 * is not under the menu's control: it survives in localStorage across builds
 * and arrives from other devices through the progress sync. So an unrecognised
 * value snaps to the nearest length rather than being trusted or discarded.
 * The menu is a `<select>`, and a value matching none of its options makes it
 * display the first one — the learner would read "5 days" above a plan laid out
 * over six weeks, which is the kind of quiet lie nobody traces back.
 *
 * The snapping happens here, at the point of reading, and nothing writes the
 * snapped value back. A longer window written by some future build therefore
 * survives a visit from this one intact.
 *
 * A value sitting exactly between two lengths takes the shorter one. Six days
 * becomes five rather than seven, so a plan built for a window we had to guess
 * at finishes inside the time the learner has rather than a day after it.
 */
export function resolveDuration(days: number | undefined): PlanDuration {
  if (typeof days !== "number" || !Number.isFinite(days)) return FOUR_WEEKS;
  let best = FOUR_WEEKS;
  for (const d of PLAN_DURATIONS) {
    if (Math.abs(d.days - days) < Math.abs(best.days - days)) best = d;
  }
  return best;
}

const MODULES: ModuleName[] = ["listening", "reading", "writing", "speaking"];

/** "grammar", "grammar and reading", "grammar, vocabulary and reading" */
export function listJoin(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Divides the window between the blocks, spare days to the front.
 *
 * The blocks run weakest module first, so the block handed the extra day is the
 * one the learner most needs it on. Twenty-one days becomes 6-5-5-5 rather than
 * 5-5-5-6, and the spare day lands where it does the most good.
 */
function shareDays(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const extra = total % parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * What a block of days is called.
 *
 * Four weeks divides into exact weeks, and "Week 2" is friendlier than
 * "Days 8–14", so a block that lines up with a week is still called one. Every
 * other window produces uneven blocks, and there the day range is the only
 * honest label — a learner shown "Week 2" on a five-day plan would be reading a
 * word the plan cannot deliver.
 */
function blockLabel(start: number, days: number): string {
  if (days === 7 && (start - 1) % 7 === 0) return `Week ${(start - 1) / 7 + 1}`;
  if (days === 1) return `Day ${start}`;
  return `Days ${start}–${start + days - 1}`;
}

/**
 * As much of a module's task list as its share of days can carry.
 *
 * A week is the yardstick because these lists were written for the four-week
 * plan: at seven days a block still gets everything it always got, and shorter
 * blocks get proportionally less. Never less than one task, or a block would be
 * a heading with nothing underneath it.
 *
 * The lists run easiest first and end with "generate a fresh test with AI", so
 * trimming from the end drops exactly the right things. Someone with five days
 * should be working through material that already exists rather than waiting on
 * new material to be written for them.
 */
function fitTasks(all: PlanTask[], days: number): PlanTask[] {
  const room = Math.max(1, Math.round((all.length * days) / 7));
  return all.slice(0, Math.min(all.length, room));
}

/**
 * Rule-based personalised study plan, laid out over the window the learner
 * chose. Uses the placement result plus any completed module tests to find weak
 * areas and to order what each block focuses on.
 */
export function buildPlan(profile: Profile): StudyPlan | null {
  const placement = profile.placement;
  if (!placement) return null;

  const currentBand = placement.band;
  const targetBand = profile.targetBand ?? Math.min(9, currentBand + 1);
  const gap = Math.max(0, targetBand - currentBand);
  const duration = resolveDuration(profile.planDays);

  // Weakness scoring: placement skill breakdown + latest module bands.
  const weakSkills: string[] = [];
  const skillRatios = Object.entries(placement.bySkill)
    .map(([skill, s]) => ({ skill, ratio: s.total ? s.correct / s.total : 1 }))
    .sort((a, b) => a.ratio - b.ratio);
  for (const s of skillRatios) {
    if (s.ratio < 0.7) weakSkills.push(s.skill);
  }

  const moduleBands = new Map<ModuleName, number>();
  for (const m of MODULES) {
    const latest = latestFor(profile.results, m);
    if (latest) moduleBands.set(m, latest.band);
  }

  // Order modules: untested first (need a baseline), then lowest band first.
  const ordered = [...MODULES].sort((a, b) => {
    const ba = moduleBands.get(a);
    const bb = moduleBands.get(b);
    if (ba === undefined && bb === undefined) return 0;
    if (ba === undefined) return -1;
    if (bb === undefined) return 1;
    return ba - bb;
  });

  const moduleTasks: Record<ModuleName, PlanTask[]> = {
    listening: [
      { label: "Booking a Badminton Class — everyday dialogue", href: "/practice/listening?id=listening-1" },
      { label: "Renting an Allotment Plot — everyday dialogue", href: "/practice/listening?id=listening-3" },
      { label: "The History of Timekeeping — academic lecture", href: "/practice/listening?id=listening-2" },
      { label: "What Museums Choose to Keep — academic lecture", href: "/practice/listening?id=listening-4" },
      { label: "Generate a fresh listening test with AI", href: "/practice#generate" },
    ],
    reading: [
      { label: "The Rise of the Lighthouse (medium)", href: "/practice/reading?id=reading-1" },
      { label: "How Seeds Travel (medium)", href: "/practice/reading?id=reading-3" },
      { label: "The Outsourced Mind (hard)", href: "/practice/reading?id=reading-2" },
      { label: "The Value of Waiting (hard)", href: "/practice/reading?id=reading-4" },
      {
        label: "Buried Rivers — headings, Yes/No, short answer (medium)",
        href: "/practice/reading?id=reading-5",
      },
      { label: "Generate a fresh reading test with AI", href: "/practice#generate" },
    ],
    writing: [
      { label: "Task 1 report practice with AI feedback", href: "/practice/writing" },
      { label: "Task 2 essay practice with AI feedback", href: "/practice/writing" },
    ],
    speaking: [
      { label: "Full mock speaking interview with the AI examiner", href: "/speaking" },
      { label: "Repeat Part 2 cue card, aim for the full 2 minutes", href: "/speaking" },
    ],
  };

  const focusLabel: Record<ModuleName, string> = {
    listening: "Listening",
    reading: "Reading",
    writing: "Writing",
    speaking: "Speaking",
  };

  const rationaleFor = (m: ModuleName): string => {
    const band = moduleBands.get(m);
    if (band === undefined) {
      return "You have not taken a scored " + focusLabel[m].toLowerCase() + " test yet — establish a baseline first.";
    }
    if (band < targetBand) {
      return `Your latest ${focusLabel[m].toLowerCase()} band is ${band}, below your target of ${targetBand}.`;
    }
    return `Keep your ${focusLabel[m].toLowerCase()} sharp — you are at or above target here.`;
  };

  /*
    The placement test is how the plan measures progress, so it only belongs at
    the end of a window long enough to have produced some. Sitting it again
    after four days measures the mood the learner woke up in, and a score that
    falls for that reason costs more confidence than the retake was ever worth.
  */
  const retakeFits = duration.days >= 14;

  const share = shareDays(duration.days, ordered.length);
  const starts: number[] = [];
  let nextDay = 1;
  for (const d of share) {
    starts.push(nextDay);
    nextDay += d;
  }

  const blocks: PlanBlock[] = ordered.map((m, i) => ({
    step: i + 1,
    label: blockLabel(starts[i], share[i]),
    days: share[i],
    focus: focusLabel[m],
    rationale: rationaleFor(m),
    tasks: [
      ...fitTasks(moduleTasks[m], share[i]),
      // Weak underlying skills are fixed in the study sections, not by sitting
      // another exam paper — so the plan sends the learner there first. These
      // are not trimmed along with the window: a drill is fifteen minutes, and
      // on a short plan it is the best fifteen minutes on offer.
      ...(weakSkills.includes("grammar") && (m === "reading" || m === "writing")
        ? [{ label: "Grammar practice — drill your weakest topic", href: "/grammar" }]
        : []),
      ...(weakSkills.includes("vocabulary") && (m === "reading" || m === "speaking")
        ? [{ label: "Vocabulary practice — collocations and word families", href: "/vocabulary" }]
        : []),
      ...(weakSkills.length > 0 && retakeFits && (m === "reading" || m === "writing")
        ? [
            {
              label: `Brush up your ${listJoin(weakSkills)}, then retake the placement test`,
              href: "/placement",
            },
          ]
        : []),
    ],
  }));

  /*
    The retake is only named where the plan actually offers it. Told to "retake
    the placement test" by a five-day plan that then lists no retake anywhere,
    a learner is left hunting for a task that was never there, and the page
    reads as though it has lost track of what it just said. Found by reading
    the page in a browser, not by reading this file.
  */
  const bigJump = retakeFits
    ? `A jump of ${gap} bands is a long-term project, often three months or more. Treat ${duration.phrase} as one cycle: work through it, retake the placement test, then start the next one.`
    : `A jump of ${gap} bands is a long-term project, often three months or more. There is not enough room in ${duration.phrase} for all of it, so this plan spends the time you do have where it counts most.`;

  const headline =
    gap === 0
      ? `You are already at your target of band ${targetBand}. Use ${duration.phrase} to keep all four skills sharp.`
      : gap <= 0.5
        ? `You are half a band away from ${targetBand}. Focused work on your weakest module over ${duration.phrase} should close the gap.`
        : gap <= 1.5
          ? `Raising a band score by ${gap} usually takes 6-12 weeks of regular practice, so treat ${duration.phrase} as one step of that. The plan cycles all four skills, starting with your weakest.`
          : bigJump;

  const rhythm = [
    duration.days < 7
      ? "Suggested rhythm: one session of 30–60 minutes on each of the days above."
      : "Suggested rhythm: 3–5 sessions of 30–60 minutes per week.",
    retakeFits
      ? "Re-take the placement test at the end of the cycle to measure your progress, then repeat with a fresh set of AI-generated tests."
      : "When the days are up, pick a longer window and keep going.",
  ].join(" ");

  return { currentBand, targetBand, gap, duration, headline, rhythm, blocks, weakSkills };
}
