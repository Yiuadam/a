"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

/*
  Which question the learner is actually looking at.

  ---------------------------------------------------------------------------
  Why this exists at all

  The bottom strip used to highlight whichever number was last pressed, which
  meant it only ever told you where you had been. A candidate who read down
  three questions saw the strip still pointing at the one they had finished
  with, and the "mark this one hard" button offering to mark a question that
  was no longer on the screen. The strip is the one piece of exam furniture
  whose whole job is to say where you are, so it has to answer the scroll
  rather than the last tap.

  ---------------------------------------------------------------------------
  Why an IntersectionObserver rather than scroll arithmetic

  Reading positions could be worked out by measuring every card against the
  scroll offset on every scroll event, and that is the version that goes wrong
  on a phone: it runs on the main thread during momentum scrolling, which is
  exactly when the browser has least to spare, and it has to know which element
  is the scroll container — and here that is the passage pane on a wide screen,
  the swipe panel on a narrow one, and neither during a mock's passage switch.

  An observer is told by the browser, off the main thread, and knows nothing
  about containers: a card that has been scrolled out of its pane is clipped by
  that pane and simply stops intersecting. The same code therefore works for
  the split panes, the phone's swipe track, and the mock's one-passage-at-a-time
  layout without knowing that any of them exist.

  ---------------------------------------------------------------------------
  Where the reading line sits, and why it is the middle

  The obvious choice is the top of the pane, and it is wrong: a question you
  have finished with keeps the highlight while three of its pixels are still
  showing. So the line sits away from the edge, and the band around it is thin
  — thin enough that at most two cards ever cross it, so the answer is stable
  rather than flickering between neighbours.

  It is the middle specifically because that is where `jump` puts a question it
  has been asked to scroll to (`block: "center"`). Any other line and tapping
  23 would leave the strip highlighting 22 the moment the learner scrolled a
  pixel — the one thing a strip like this must never do.
*/
export const READING_BAND = "-45% 0px -45% 0px";

/*
  How long a programmatic scroll is given to finish before the observer is
  believed again.

  Smooth scrolling is animated by the browser over a duration it chooses, and
  every question the animation flies past reports itself as reached. Without
  this window, tapping 23 would run the highlight up through 5, 9, 14 and stop
  wherever the last frame happened to land.
*/
export const SETTLE_MS = 700;

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/*
  Smooth unless the learner has asked their system for less movement, in which
  case the jump is instant. Someone who gets motion sick from a scrolling page
  should not be made to watch forty questions go by to reach one of them.
*/
export function scrollBehaviour(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}

/*
  Of the questions crossing the reading line, the one furthest into the paper.

  Two cards can cross a band at once, at the moment one hands over to the next.
  Taking the later one means the strip moves with the scroll instead of lagging
  a question behind it — and it means a jump lands on its target even when the
  question above it still has its last line in the band.

  Kept separate from the observer so the rule can be tested without a browser.
*/
export function furthestInBand(
  crossing: Iterable<string>,
  order: ReadonlyMap<string, number>,
): string | null {
  let furthest: string | null = null;
  let furthestAt = -1;
  for (const id of crossing) {
    const at = order.get(id);
    if (at === undefined || at <= furthestAt) continue;
    furthest = id;
    furthestAt = at;
  }
  return furthest;
}

/*
  Whether a report from the observer is one the strip should act on.

  Two reports are not: the one the browser sends the instant it is given
  something to watch, which describes a paper nobody has scrolled yet and would
  move the strip off question 1 before the learner had touched it; and any that
  arrive while a scroll this app started is still running, which describe
  questions being flown past rather than questions being read.

  Kept separate from the observer so both rules can be tested without a browser.
*/
export function shouldFollow(gate: {
  opened: boolean;
  now: number;
  quietUntil: number;
}): boolean {
  return gate.opened && gate.now >= gate.quietUntil;
}

export interface ReadingPosition {
  /**
   * Stop believing the observer for a moment, because a scroll we started
   * ourselves is about to move every card on the screen.
   */
  holdWhileScrolling: () => void;
}

/**
 * Watch the question cards and report whichever one is at the reading line.
 *
 * `ids` is the paper in the order the exam numbers it; the cards are found by
 * the `data-question-id` anchor they already carry for `jump`.
 */
export function useReadingPosition(
  ids: string[],
  onReach: (id: string) => void,
): ReadingPosition {
  /*
    Both of these are read inside the effect rather than listed as its
    dependencies, so that answering a question — which hands this hook a new
    array and a new callback every time — does not tear the observer down and
    build it again. The effect is rebuilt when the paper changes, and only then.
  */
  const onReachRef = useRef(onReach);
  const idsRef = useRef(ids);
  /*
    Copied in an effect of their own rather than during the render, because a
    render can be started and thrown away. Declared before the observer's
    effect, so the copies are already current by the time it is built.
  */
  useEffect(() => {
    onReachRef.current = onReach;
    idsRef.current = ids;
  });

  /* A separator no question id can contain, so two different papers can
     never hash to the same string and leave the observer watching the
     wrong one. */
  const paper = useMemo(() => ids.join("\u0000"), [ids]);

  const quietUntil = useRef(0);
  /*
    Survives the effect deliberately. An observer reports the state of the page
    the instant it is given something to watch, and on the very first of those
    reports nothing has been scrolled — moving the strip off question 1 before
    the learner has touched the paper would be the app answering a question
    nobody asked. Every later report, including the ones a mock's passage
    switch produces, is a real change and is published.
  */
  const opened = useRef(false);

  const holdWhileScrolling = useCallback(() => {
    quietUntil.current = Date.now() + SETTLE_MS;
  }, []);

  useEffect(() => {
    /* Server rendering, and the odd browser without the API, keep the strip
       exactly as it behaved before: driven by taps alone. */
    if (typeof IntersectionObserver === "undefined") return;

    const order = new Map(idsRef.current.map((id, at) => [id, at] as const));
    if (order.size === 0) return;

    const crossing = new Set<string>();
    const watched = new Set<HTMLElement>();

    const publish = () => {
      const following = shouldFollow({
        opened: opened.current,
        now: Date.now(),
        quietUntil: quietUntil.current,
      });
      opened.current = true;
      if (!following) return;
      const reached = furthestInBand(crossing, order);
      /*
        Nothing in the band happens between two cards and at the ends of the
        paper. Holding the last answer is right: the learner is still on the
        question they were on, and blanking the strip there would make it
        flicker at every gap.
      */
      if (reached !== null) onReachRef.current(reached);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.questionId;
          if (id === undefined) continue;
          if (entry.isIntersecting) crossing.add(id);
          else crossing.delete(id);
        }
        publish();
      },
      { rootMargin: READING_BAND, threshold: 0 },
    );

    const rescan = () => {
      for (const el of Array.from(watched)) {
        if (el.isConnected) continue;
        watched.delete(el);
        observer.unobserve(el);
        const id = el.dataset.questionId;
        if (id !== undefined) crossing.delete(id);
      }
      for (const id of order.keys()) {
        const el = document.querySelector<HTMLElement>(
          `[data-question-id="${CSS.escape(id)}"]`,
        );
        if (!el || watched.has(el)) continue;
        watched.add(el);
        observer.observe(el);
      }
    };

    rescan();

    /*
      A mock sitting mounts one passage at a time, so thirteen of the forty
      cards are replaced by thirteen others without the palette changing at
      all. Watching for that keeps the strip alive across a passage switch;
      without it the observer would go on watching elements that had been
      thrown away and the highlight would freeze.

      Scoped to the exam frame, and to structural changes only, so answering a
      question or ticking a box — which change attributes, not children — cost
      nothing. The rescan is deferred a frame so a burst of mutations is
      answered once.
    */
    const frame = document.querySelector("[data-exam]") ?? document.body;
    let queued = 0;
    const remount = new MutationObserver(() => {
      if (queued) return;
      queued = requestAnimationFrame(() => {
        queued = 0;
        rescan();
      });
    });
    remount.observe(frame, { childList: true, subtree: true });

    return () => {
      if (queued) cancelAnimationFrame(queued);
      remount.disconnect();
      observer.disconnect();
    };
  }, [paper]);

  return { holdWhileScrolling };
}
