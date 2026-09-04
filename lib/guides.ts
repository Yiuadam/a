import type { IconName } from "@/components/Icons";

/*
  The four skill guides, shared by the overview and by each skill's own page.

  They live here rather than in the page because two routes render them now:
  /resources lists them as four buttons, and /resources/[skill] is the whole
  advice for one of them. Keeping one copy is what stops the list and the page
  disagreeing about how many tips there are.
*/
export interface SkillGuide {
  slug: string;
  icon: IconName;
  title: string;
  time: string;
  tips: string[];
}

export const SKILL_GUIDES: SkillGuide[] = [
  {
    slug: "listening",
    icon: "listening",
    title: "Listening",
    time: "30 minutes · 40 questions · 4 sections",
    tips: [
      "You hear the recording once. Read the questions during the pause before each section so you know what to listen for.",
      "Answers come in order. If you miss one, let it go and catch the next — chasing it costs you two more.",
      "Spelling and grammar count. \"childrens\" or a missing plural s marks the answer wrong even if you heard it correctly.",
      "Watch for corrections: speakers say \"Tuesday — sorry, Thursday\". The second one is the answer.",
      "Respect the word limit. \"No more than two words\" means three words scores zero.",
    ],
  },
  {
    slug: "reading",
    icon: "reading",
    title: "Reading",
    time: "60 minutes · 40 questions · 3 passages",
    tips: [
      "Don't read the whole passage first. Read the questions, then scan for the answer.",
      "Budget 20 minutes per passage. If you're stuck, guess and move on — every question is worth the same.",
      "True/False/Not Given: FALSE means the passage says the opposite. NOT GIVEN means the passage simply doesn't mention it. When in doubt between them, ask \"does the text contradict this, or just stay silent?\"",
      "Answers are paraphrased, not copied. Look for the idea, not the exact words.",
      "For completion questions, copy the word exactly as it appears in the passage.",
    ],
  },
  {
    slug: "writing",
    icon: "writing",
    title: "Writing",
    time: "60 minutes · Task 1 (20 min) + Task 2 (40 min)",
    tips: [
      "Task 2 is worth twice as much as Task 1. Do Task 1 first but never let it eat into your 40 minutes.",
      "Task 1 needs an overview paragraph — the single biggest trend or difference. Missing it caps your Task Achievement score.",
      "Never give an opinion in Academic Task 1. Report what the data shows, nothing more.",
      "In Task 2, answer every part of the question. \"Discuss both views and give your opinion\" is three jobs, not one.",
      "Under length is an automatic penalty. Aim for 170 and 270 words rather than the bare 150 and 250.",
      "Spend the last 3 minutes checking articles, plurals and verb tenses — the errors that cost the most marks.",
    ],
  },
  {
    slug: "speaking",
    icon: "speaking",
    title: "Speaking",
    time: "11–14 minutes · 3 parts, face to face",
    tips: [
      "Part 1 answers should be two or three sentences. One word is too short; a speech is too long.",
      "In Part 2 use the full two minutes. Use the preparation minute to note keywords, not sentences.",
      "It's fine to invent details. You're scored on your English, not on whether the story is true.",
      "Part 3 wants opinions and reasons: state a view, explain why, give an example, consider the other side.",
      "If you don't know a word, paraphrase around it. Paraphrasing scores; silence doesn't.",
      "Fluency beats perfection. Keep going rather than restarting sentences to fix small errors.",
    ],
  },
];

export function guideFor(slug: string): SkillGuide | undefined {
  return SKILL_GUIDES.find((guide) => guide.slug === slug);
}
