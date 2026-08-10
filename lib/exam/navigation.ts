"use client";

import { useCallback, useMemo, useState } from "react";
import type { PaletteItem } from "@/components/exam/QuestionPalette";

/*
  Which question you are on, and which ones you have flagged.

  Kept out of the pages because both Reading and Listening need exactly this
  and neither should own it, and because the numbering rule is subtle enough to
  be worth writing once: the exam numbers a paper 1 to 40 straight through,
  across every group and every passage. A page that numbered each group from 1
  would look right on screen and be wrong the moment somebody said "I'm stuck
  on 23".
*/

export interface NavQuestion {
  id: string;
  /** Whether the learner has put anything against it. */
  answered: boolean;
}

export function useExamNavigation(questions: NavQuestion[]) {
  const [currentId, setCurrentId] = useState<string | null>(questions[0]?.id ?? null);
  const [flagged, setFlagged] = useState<Record<string, true>>({});

  const items: PaletteItem[] = useMemo(
    () =>
      questions.map((q, index) => ({
        id: q.id,
        number: index + 1,
        answered: q.answered,
        flagged: flagged[q.id] === true,
      })),
    [questions, flagged],
  );

  /*
    Falls back to the first question rather than to null when the current id is
    no longer in the list — which happens when a learner switches paper without
    leaving the page. A palette with nothing current has no working prev/next.
  */
  const index = Math.max(
    0,
    questions.findIndex((q) => q.id === currentId),
  );

  const jump = useCallback((id: string) => {
    setCurrentId(id);
    /*
      Scrolling is the page's job, not this hook's, but every caller wants it,
      so it is done here against a stable id convention rather than repeated.
      `block: "center"` because "start" puts the question under the sticky
      chrome on a short screen.
    */
    if (typeof document !== "undefined") {
      document
        .querySelector(`[data-question-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, []);

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
    Round-robin through the flagged questions, from wherever you are.

    Wrapping matters: a candidate who flags three and reaches the last one
    expects the next press to take them back to the first, not to do nothing.
    Without the wrap the control appears broken exactly when it has finished
    being useful.
  */
  const nextFlagged = useCallback(() => {
    const flaggedIds = questions.map((q) => q.id).filter((id) => flagged[id]);
    if (flaggedIds.length === 0) return;
    const after = flaggedIds.find((id) => questions.findIndex((q) => q.id === id) > index);
    jump(after ?? flaggedIds[0]);
  }, [questions, flagged, index, jump]);

  return {
    items,
    nextFlagged,
    currentId: questions[index]?.id ?? null,
    jump,
    prev: useCallback(() => step(-1), [step]),
    next: useCallback(() => step(1), [step]),
    toggleReview,
    flaggedCount: Object.keys(flagged).length,
  };
}
