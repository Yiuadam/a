"use client";

import { useEffect } from "react";

/**
 * Opening the site puts you at the top of it.
 *
 * Browsers remember where you were and put you back there, which is the right
 * default for a page you left in the middle of and came back to. It is the
 * wrong one for opening an app: a learner tapping the bookmark landed halfway
 * down the practice list, with the header and everything above it scrolled
 * off, and nothing on screen to say why.
 *
 * Back and forward are deliberately left alone. Restoring the scroll position
 * is the whole point of going back — a learner who scrolls a long reading
 * passage, follows a link and returns expects to be where they were, and
 * taking that away to fix the bookmark case would be a worse trade than the
 * bug. `back_forward` is exactly that traversal, so it is the one navigation
 * type this stands down for.
 *
 * `history.scrollRestoration` is deliberately not touched. Setting it to
 * "manual" would fix this too, and would also switch off restoration for every
 * later back and forward in the session, which is the behaviour worth keeping.
 * Scrolling once, on the navigation that needs it, changes nothing else.
 *
 * It runs twice on purpose. The effect fires after hydration, but some engines
 * restore the old offset around the load event, which can be after that — so
 * whichever happens second wins, and both land in the same place.
 */
export default function ScrollToTopOnOpen() {
  useEffect(() => {
    const entries = performance.getEntriesByType("navigation");
    const type = (entries[0] as PerformanceNavigationTiming | undefined)?.type;
    if (type === "back_forward") return;

    /* `instant`, not the page's smooth default: this is where the page was
       always meant to open, not a journey the learner asked to watch. */
    const toTop = () => window.scrollTo({ top: 0, left: 0, behavior: "instant" });

    toTop();
    if (document.readyState === "complete") return;
    window.addEventListener("load", toTop, { once: true });
    return () => window.removeEventListener("load", toTop);
  }, []);

  return null;
}
