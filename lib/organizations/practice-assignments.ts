import { LISTENING_TESTS, READING_TESTS } from "@/lib/tests";

export type OrganizationPracticeSkill = "listening" | "reading" | "writing" | "speaking";

export interface OrganizationPracticeTarget {
  skill: OrganizationPracticeSkill;
  testId: string;
  title: string;
  href: string;
}

/**
 * The allow-listed work that an organization can assign. We derive paper
 * names/links from the same registry learners use, so an assignment cannot
 * point to a dead paper or an arbitrary URL.
 */
export const ORGANIZATION_PRACTICE_TARGETS: readonly OrganizationPracticeTarget[] = [
  ...LISTENING_TESTS.map((test) => ({
    skill: "listening" as const,
    testId: test.id,
    title: `Listening · ${test.title}`,
    href: `/practice/listening?id=${encodeURIComponent(test.id)}`,
  })),
  ...READING_TESTS.map((test) => ({
    skill: "reading" as const,
    testId: test.id,
    title: `Reading · ${test.title}`,
    href: `/practice/reading?id=${encodeURIComponent(test.id)}`,
  })),
  {
    skill: "writing",
    testId: "next-writing",
    title: "Writing · next practice task",
    href: "/practice/writing",
  },
  {
    skill: "speaking",
    testId: "next-speaking",
    title: "Speaking · next interview",
    href: "/speaking",
  },
];

export function organizationPracticeTarget(
  skill: unknown,
  testId: unknown,
): OrganizationPracticeTarget | null {
  if (typeof skill !== "string" || typeof testId !== "string") return null;
  return ORGANIZATION_PRACTICE_TARGETS.find(
    (target) => target.skill === skill && target.testId === testId,
  ) ?? null;
}

export function organizationPracticeCompleted(
  skill: OrganizationPracticeSkill,
  testId: string,
  submittedTestId: string,
): boolean {
  return skill === "writing" || skill === "speaking"
    ? true
    : submittedTestId === testId;
}
