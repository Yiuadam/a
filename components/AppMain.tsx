"use client";

import { usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";

/*
  The page area, and the one route that does not want it.

  Every learner-facing page sits in a centred column with a maximum width,
  because prose past about ninety characters is measurably harder to read — the
  eye loses the start of the next line on the way back. That is the right
  default and it is why the container exists.

  A console is not prose. It is tiles and charts, and the more of them that fit
  side by side the fewer things are hidden below the fold — which is the whole
  point of a screen you glance at. So /admin gets the full width of the window.

  Done here rather than with negative margins in the console itself, which was
  the first attempt: `-mx-5` cancels the padding and leaves `max-w-6xl` and
  `mx-auto` untouched, so the dashboard stayed capped and centred with a band of
  page either side of it. Cancelling a container from the inside only ever
  removes the part of it you remembered.
*/

export default function AppMain({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const console_ = pathname.startsWith("/admin");
  const workspace = pathname.startsWith("/organization");
  const viewportLocked =
    pathname === "/chat" ||
    pathname === "/practice/listening" ||
    pathname === "/practice/reading" ||
    pathname === "/practice/writing" ||
    pathname === "/exam";
  /* The homepage is full-bleed, but it is still a document. Locking it to one
     viewport makes the legal footer take height away from the card grid; in a
     narrow or short window the hero then collapses and the final study cards
     sit behind a separate inner scroller. */
  const fullBleed = pathname === "/" || viewportLocked;

  useEffect(() => {
    if (!viewportLocked) return;
    document.body.setAttribute("data-viewport-locked", "");
    return () => {
      document.body.removeAttribute("data-viewport-locked");
    };
  }, [viewportLocked]);

  return (
    <main
      /*
        `data-lookupable` means any word a learner selects anywhere in the app —
        a passage, a transcript, a question, an explanation — can be looked up
        without leaving the page.
      */
      data-lookupable
      className={
        console_ || workspace || fullBleed
          ? "w-full min-h-0 flex-1"
          : /* Less air above and below on a phone. Forty pixels top and bottom
               is right on a laptop, where the page is a document in a window;
               on a 844-pixel screen it is a tenth of everything there is, spent
               before the first word. */
            /* `min-h-0` so a child that wants to scroll inside this column can.
               Without it a flex item refuses to shrink below its content and
               the whole page scrolls instead of the conversation. */
            "mx-auto w-full min-h-0 max-w-5xl flex-1 px-5 py-6 sm:py-10 lg:max-w-6xl xl:max-w-7xl 2xl:max-w-[96rem]"
      }
    >
      {children}
    </main>
  );
}
