import readingOne from "@/data/reading-1.json";
import readingTwo from "@/data/reading-2.json";
import readingThree from "@/data/reading-3.json";
import readingFour from "@/data/reading-4.json";
import readingFive from "@/data/reading-5.json";
import readingSix from "@/data/reading-6.json";
import readingSeven from "@/data/reading-7.json";
import readingEight from "@/data/reading-8.json";
import readingNine from "@/data/reading-9.json";
import readingTen from "@/data/reading-10.json";
import listeningOne from "@/data/listening-1.json";
import listeningTwo from "@/data/listening-2.json";
import listeningThree from "@/data/listening-3.json";
import listeningFour from "@/data/listening-4.json";
import listeningFive from "@/data/listening-5.json";
import listeningSix from "@/data/listening-6.json";
import listeningSeven from "@/data/listening-7.json";
import listeningEight from "@/data/listening-8.json";
import listeningNine from "@/data/listening-9.json";
import listeningTen from "@/data/listening-10.json";
import listeningEleven from "@/data/listening-11.json";
import type { ListeningTest, ReadingTest } from "@/lib/types";

/*
  Every paper in the app, in one place.

  ---------------------------------------------------------------------------
  Why a registry rather than an import list per page

  Because there were three of them and they disagreed. /practice imported four
  reading papers and four listening; /practice/reading imported five; and
  listening-5 and listening-6 had been written, validated and committed and
  were reachable from nowhere at all. Two finished papers, invisible.

  Nothing failed, because nothing could: an unused JSON file is not an error in
  any language. So the fix is structural — one list, three consumers, and a
  test that walks the data directory and fails if a paper on disk is missing
  from here. Adding a paper is now one import and one array entry, and
  forgetting to show it is a red build rather than a quiet nothing.

  ---------------------------------------------------------------------------
  The order

  Easier first, which is not the order they were written in. A learner opening
  the list is choosing, not browsing, and the choice they can most often make
  well is "start with a straightforward one". Within a difficulty the authored
  order is kept, so a paper's position only moves when its difficulty does.
*/

const DIFFICULTY_ORDER = ["easy", "medium", "hard"];

function byDifficulty<T extends { difficulty: string }>(tests: T[]): T[] {
  return [...tests]
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const ra = DIFFICULTY_ORDER.indexOf(a.t.difficulty);
      const rb = DIFFICULTY_ORDER.indexOf(b.t.difficulty);
      /* An unknown difficulty sorts last rather than first: better to bury a
         mislabelled paper than to open the list with one. */
      return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb) || a.i - b.i;
    })
    .map((x) => x.t);
}

export const READING_TESTS: ReadingTest[] = byDifficulty([
  readingOne,
  readingTwo,
  readingThree,
  readingFour,
  readingFive,
  readingSix,
  readingSeven,
  readingEight,
  readingNine,
  readingTen,
] as ReadingTest[]);

export const LISTENING_TESTS: ListeningTest[] = byDifficulty([
  listeningOne,
  listeningTwo,
  listeningThree,
  listeningFour,
  listeningFive,
  listeningSix,
  listeningSeven,
  listeningEight,
  listeningNine,
  listeningTen,
  listeningEleven,
] as ListeningTest[]);
