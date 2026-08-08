import type { ModuleName, Profile } from "./types";

export interface PlanTask {
  label: string;
  href: string;
}

export interface PlanWeek {
  week: number;
  focus: string;
  rationale: string;
  tasks: PlanTask[];
}

export interface StudyPlan {
  currentBand: number;
  targetBand: number;
  gap: number;
  headline: string;
  weeks: PlanWeek[];
  weakSkills: string[];
}

const MODULES: ModuleName[] = ["listening", "reading", "writing", "speaking"];

/** "grammar", "grammar and reading", "grammar, vocabulary and reading" */
export function listJoin(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Rule-based personalised 4-week plan. Uses the placement result plus any
 * completed module tests to find weak areas and order the weekly focus.
 */
export function buildPlan(profile: Profile): StudyPlan | null {
  const placement = profile.placement;
  if (!placement) return null;

  const currentBand = placement.band;
  const targetBand = profile.targetBand ?? Math.min(9, currentBand + 1);
  const gap = Math.max(0, targetBand - currentBand);

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
    const latest = profile.results.find((r) => r.module === m);
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

  const weeks: PlanWeek[] = ordered.map((m, i) => ({
    week: i + 1,
    focus: focusLabel[m],
    rationale: rationaleFor(m),
    tasks: [
      ...moduleTasks[m],
      // Weak underlying skills are fixed in the study sections, not by sitting
      // another exam paper — so the plan sends the learner there first.
      ...(weakSkills.includes("grammar") && (m === "reading" || m === "writing")
        ? [{ label: "Grammar practice — drill your weakest topic", href: "/grammar" }]
        : []),
      ...(weakSkills.includes("vocabulary") && (m === "reading" || m === "speaking")
        ? [{ label: "Vocabulary practice — collocations and word families", href: "/vocabulary" }]
        : []),
      ...(weakSkills.length > 0 && (m === "reading" || m === "writing")
        ? [
            {
              label: `Brush up your ${listJoin(weakSkills)}, then retake the placement test`,
              href: "/placement",
            },
          ]
        : []),
    ],
  }));

  const headline =
    gap === 0
      ? `You are already at your target of band ${targetBand}. Focus on consistency across all four skills.`
      : gap <= 0.5
        ? `You are half a band away from ${targetBand}. Targeted practice in your weakest module should close the gap.`
        : gap <= 1.5
          ? `Raising a band score by ${gap} typically takes 6-12 weeks of regular practice. This plan cycles all four skills, starting with your weakest.`
          : `A jump of ${gap} bands is a long-term project (often 3+ months). Repeat this 4-week cycle, retaking the placement test each cycle to track progress.`;

  return { currentBand, targetBand, gap, headline, weeks, weakSkills };
}
