"use client";

import { useCallback, useMemo, useState } from "react";
import type { PaletteItem } from "@/components/exam/QuestionPalette";
import { scrollBehaviour, useReadingPosition } from "@/lib/exam/reading-position";

/*
  Which question you are on, and which ones you have flagged.

  Kept out of the pages because both Reading and Listening need exactly this
  and neither should own it, and because the numbering rule is subtle enough to
  be worth writing once: the exam numbers a paper 1 to 40 straight through,
  across every group and every passage. A page that numbered each group from 1
  would look right on screen and be wrong the moment somebody said "I'm stuck
  on 23".

  "Which question you are on" is answered by the paper rather than by the last
  tap: scrolling down to question 23 makes 23 the current one, exactly as if it
  had been tapped. Taps and the arrows still work, and still scroll — they are
  now one of two ways to move rather than the only one. See
  lib/exam/reading-position.ts for how the paper is read.
*/

export interface NavQuestion {
  id: string;
  /** Whether the learner has put anything against it. */
  answered: boolean;
  /**
   * How many consecutive paper numbers this one claims. Defaults to 1; only a
   * multi-select group claims more than one for a single answered item — see
   * `questionWidth` in lib/questions.ts, which every caller should derive
   * this from rather than assume it.
   */
  width?: number;
}

export function useExamNavigation(questions: NavQuestion[]) {
  const [currentId, setCurrentId] = useState<string | null>(questions[0]?.id ?? null);
  const [flagged, setFlagged] = useState<Record<string, true>>({});

  const items: PaletteItem[] = useMemo(() => {
    /*
      A running counter rather than `index + 1`. Every question claimed
      exactly one number until a multi-select could claim two or three for a
      single answered item — indexing by array position would then hand the
      question straight after one the wrong number, disagreeing with the
      badge `numberedGroups` prints beside it on the paper itself.
    */
    let next = 1;
    const out: PaletteItem[] = [];
    for (const q of questions) {
      out.push({
        id: q.id,
        number: next,
        answered: q.answered,
        flagged: flagged[q.id] === true,
      });
      next += q.width ?? 1;
    }
    return out;
  }, [questions, flagged]);

  /*
    Falls back to the first question rather than to null when the current id is
    no longer in the list — which happens when a learner switches paper without
    leaving the page. A palette with nothing current has no working prev/next.
  */
  const index = Math.max(
    0,
    questions.findIndex((q) => q.id === currentId),
  );

  const ids = useMemo(() => questions.map((q) => q.id), [questions]);
  const { holdWhileScrolling } = useReadingPosition(ids, setCurrentId);

  const jump = useCallback(
    (id: string) => {
      /*
        The scroll started below sweeps every question between here and there
        through the reading line, and each of them would otherwise be reported
        as the one being read. Hold the strip still until the movement this
        press caused has finished, or a press on 23 ends up highlighting
        whichever number the animation's last frame happened to be passing.
      */
      holdWhileScrolling();
      setCurrentId(id);
      /*
        Scrolling is the page's job, not this hook's, but every caller wants it,
        so it is done here against a stable id convention rather than repeated.
        `block: "center"` because "start" puts the question under the sticky
        chrome on a short screen — and because the reading line the strip
        follows is the middle of the pane, so centring is what makes a jump
        agree with the highlight it leaves behind.
      */
      if (typeof document !== "undefined") {
        document
          .querySelector(`[data-question-id="${CSS.escape(id)}"]`)
          ?.scrollIntoView({ behavior: scrollBehaviour(), block: "center" });
      }
    },
    [holdWhileScrolling],
  );

  const step = useCallback(
    (delta: number) => {
      const next = questions[Math.min(questions.length - 1, Math.max(0, index + delta))];
      if (next) jump(next.id);
    },
    [questions, index, jump],
  );

  const toggleReview = useCallback(() => {
    if (!currentId) return;
    setFlagged((prev) => {
      const next = { ...prev };
      if (next[currentId]) delete next[currentId];
      else next[currentId] = true;
      return next;
    });
  }, [currentId]);

  /*
    There is no control that walks between the marked questions any more, and
    none is needed: a marked question keeps its number blue in the strip, the
    strip now follows the paper so those blue numbers come past as you work,
    and one tap on one goes there. A button for it was a second way to do the
    same thing, on a bar with no room to spare.
  */

  return {
    items,
    currentId: questions[index]?.id ?? null,
    jump,
    prev: useCallback(() => step(-1), [step]),
    next: useCallback(() => step(1), [step]),
    toggleReview,
    flaggedCount: Object.keys(flagged).length,
  };
}
