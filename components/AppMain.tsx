"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

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

  return (
    <main
      /*
        `data-lookupable` means any word a learner selects anywhere in the app —
        a passage, a transcript, a question, an explanation — can be looked up
        without leaving the page.
      */
      data-lookupable
      className={
        console_
          ? "w-full flex-1"
          : "mx-auto w-full max-w-5xl flex-1 px-5 py-10 lg:max-w-6xl xl:max-w-7xl 2xl:max-w-[96rem]"
      }
    >
      {children}
    </main>
  );
}
