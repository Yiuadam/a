import { LEVELS, SKILLS } from "./band";
import type { CEFRLevel, PlacementResult, TestQuestion } from "./types";

/*
  Advice is generated from the shape of a learner's mistakes rather than from
  their score. Two people can miss the same number of questions for completely
  different reasons — one runs out of time, one misreads the question type —
  and telling them both to "practise more" helps neither.
*/

const SKILL_ADVICE: Record<string, string> = {
  grammar:
    "Grammar was your weakest area. Pick one structure a week — conditionals, then perfect tenses, then relative clauses — and write five sentences of your own with each. Recognising a form in a multiple-choice question is easier than producing it, so production practice is what moves the band.",
  vocabulary:
    "Vocabulary held you back most. Keep a notebook of words you meet in the reading passages here, and record the whole phrase rather than the single word — examiners credit natural collocation, so \"a sharp rise\" is worth more to you than \"rise\".",
  reading:
    "Reading comprehension was your weakest area. Work on locating information rather than reading every word: skim for the paragraph first, then read that paragraph closely. Most lost marks come from answering with a plausible idea rather than the one actually stated.",
};

const LEVEL_ADVICE: Record<CEFRLevel, string> = {
  A1: "Build the foundations first: present and past simple, basic question forms, and the thousand most common words. Everything above this rests on them.",
  A2: "Consolidate everyday grammar — articles, plurals, prepositions of time and place — and read short texts daily rather than long ones weekly.",
  B1: "You have the basics. Push into complex sentences: because/although/which clauses, and the present perfect versus past simple distinction that examiners listen for.",
  B2: "You are around the level of a band 6. To move up, work on precision — word choice, article use and verb patterns — rather than on learning new structures.",
  C1: "Your control is strong. Marks now come from range and nuance: hedging, emphasis, and idiomatic phrasing that sounds chosen rather than remembered.",
  C2: "You are operating near the top of the scale. Focus on exam technique and timing; the language itself is no longer the limiting factor.",
};

/** Advice after the adaptive placement test. */
export function placementAdvice(result: PlacementResult): string[] {
  const out: string[] = [];

  const rates = SKILLS.map((s) => {
    const b = result.bySkill[s];
    return { skill: s, rate: b.total > 0 ? b.correct / b.total : 1, total: b.total };
  }).filter((r) => r.total > 0);

  const weakest = [...rates].sort((a, b) => a.rate - b.rate)[0];
  const strongest = [...rates].sort((a, b) => b.rate - a.rate)[0];

  if (weakest && weakest.rate < 1) out.push(SKILL_ADVICE[weakest.skill]);
  if (strongest && weakest && strongest.skill !== weakest.skill && strongest.rate > weakest.rate) {
    out.push(
      `Your ${strongest.skill} was noticeably stronger than your ${weakest.skill}. An uneven profile costs you marks, because the overall band is pulled down by the weakest part — spend your next few sessions on ${weakest.skill}.`,
    );
  }

  // The highest level at which they were still answering correctly is a better
  // guide to what to study than the band alone.
  const ceiling = [...LEVELS].reverse().find((l) => result.byLevel[l].correct > 0);
  if (ceiling) out.push(LEVEL_ADVICE[ceiling]);

  const floor = LEVELS.find((l) => {
    const b = result.byLevel[l];
    return b.total > 0 && b.correct < b.total;
  });
  if (floor && ceiling && LEVELS.indexOf(floor) < LEVELS.indexOf(ceiling)) {
    // "an A1 question", but "a B1 question" — the letter name decides.
    const article = floor.startsWith("A") ? "an" : "a";
    out.push(
      `You missed ${article} ${floor} question but answered harder ones correctly, which usually means a gap rather than a limit. Read the explanation for that question carefully — small holes at a lower level cost marks all the way up.`,
    );
  }

  out.push(
    "Take this test again in a fortnight. It draws different questions each time and never repeats one within three sittings, so the second score is a real comparison rather than a memory test.",
  );

  return out;
}

function questionType(q: TestQuestion): string {
  return q.type;
}

/** Advice after a reading or listening practice test. */
export function testAdvice(
  module: "reading" | "listening",
  questions: TestQuestion[],
  wrongIds: string[],
  band: number,
): string[] {
  const out: string[] = [];
  const wrong = new Set(wrongIds);

  const byType = new Map<string, { wrong: number; total: number }>();
  for (const q of questions) {
    const t = questionType(q);
    const entry = byType.get(t) ?? { wrong: 0, total: 0 };
    entry.total += 1;
    if (wrong.has(q.id)) entry.wrong += 1;
    byType.set(t, entry);
  }

  const worst = [...byType.entries()]
    .filter(([, v]) => v.wrong > 0)
    .sort((a, b) => b[1].wrong / b[1].total - a[1].wrong / a[1].total)[0];

  if (worst) {
    const [type, v] = worst;
    if (type === "tfng") {
      out.push(
        `True / False / Not Given cost you ${v.wrong} of ${v.total} marks. The rule that fixes most errors: NOT GIVEN means the passage is silent on the point, while FALSE means it says the opposite. If you are arguing from what the writer would probably think, the answer is NOT GIVEN.`,
      );
    } else if (type === "mcq") {
      out.push(
        `Multiple choice cost you ${v.wrong} of ${v.total} marks. Wrong options are usually built from real words in the ${module === "reading" ? "passage" : "recording"} arranged into a claim it never makes. Find the sentence that carries the answer before you look at the options.`,
      );
    } else {
      out.push(
        `Sentence completion cost you ${v.wrong} of ${v.total} marks. Two habits recover most of these: decide what part of speech the gap needs before you search, and copy the word exactly as it appears — a changed form is marked wrong even when the meaning is right.`,
      );
    }
  }

  if (module === "listening") {
    out.push(
      wrong.size > 3
        ? "Play the recording again with the transcript open and find the exact moment each answer was said. Almost every missed answer in listening was audible — the problem is knowing when to expect it, and reading along teaches that faster than repeating the test."
        : "Before the recording starts, read the questions and predict the kind of word each gap needs — a number, a day, a material. Knowing what you are listening for is most of the skill.",
    );
  } else {
    out.push(
      wrong.size > 3
        ? "Go back to the passage and underline the sentence that answers each question you missed. If you cannot find it, the question was testing whether you would settle for a plausible idea instead of a stated one."
        : "Work on speed now rather than accuracy. In the real test you have twenty minutes per passage, so practise deciding quickly which paragraph holds the answer instead of re-reading from the top.",
    );
  }

  if (band < 6) {
    out.push(
      "At this level, one careful test a day beats three rushed ones. Do the review properly before you start the next paper — the marks come from understanding the misses, not from the volume of practice.",
    );
  } else if (band < 7.5) {
    out.push(
      "You are close to the band most universities ask for. The remaining marks are usually lost to timing and to the two or three hardest questions in each set, so practise under a strict clock from now on.",
    );
  } else {
    out.push(
      "This is a strong result. Keep the timing tight and move to the harder papers — accuracy at speed is what separates band 8 from band 7.",
    );
  }

  return out;
}
