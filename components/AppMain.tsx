"use client";

import { useEffect, type ReactNode } from "react";
import { startFreeProOffer } from "@/lib/billing/free-pro-offer";
import SideRail from "@/components/SideRail";
import SiteFooter from "@/components/SiteFooter";
import { hasSideRail } from "@/lib/nav";
import { useRoutePath } from "@/lib/hooks";

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
  /* useRoutePath, not usePathname: the routes named below are named without a
     trailing slash and the iOS export's pathname carries one, so on a phone
     every comparison here was false and the exam scrolled. See routePath in
     lib/platform.ts. */
  const pathname = useRoutePath();

  /*
    Ask about the free Pro trial from the shell, not from whatever draws it.

    The answer is one request per session, and the same call clears the guest's
    auto-accept intent — the thing that grants the trial to somebody who tapped
    "Sign up free" and then went through a sign-up flow. That has to run
    wherever they land afterwards, so it is started by the one component that is
    mounted on every route and on every platform. See lib/billing/free-pro-offer.ts.
  */
  useEffect(() => startFreeProOffer(), []);

  /*
    Every page opens at the top.

    A browser does this for you when the page itself is what scrolls. Here it
    mostly is not: `data-viewport-locked` holds the body still on almost every
    route, so the thing that actually scrolls is a container inside the page —
    the practice library's card column, for one. Nothing resets those. React
    reuses the DOM node when two routes render the same component (Reading and
    Listening both draw TestChooser), so leaving one library half way down and
    opening the other one showed it half way down too, with the heading above
    the top of the screen and no obvious way back to it. On iOS that is worse
    than it sounds: tapping the clock scrolls the *window*, and the window has
    nothing to scroll, so the one gesture everybody reaches for does nothing.

    So: on every route change, put the window back to the top and reset every
    container inside the page that has been scrolled. Checking `scrollTop`
    rather than hunting for particular class names means a container that
    scrolls for any reason is covered, including ones added later.

    Deliberately unconditional, including on Back. Restoring where somebody
    was is the friendlier behaviour in the abstract, but it is exactly what
    produced the report — and a page that always starts at the top is never
    the page you cannot climb.
  */
  useEffect(() => {
    window.scrollTo(0, 0);
    const main = document.querySelector("main");
    if (!main) return;
    if (main.scrollTop !== 0) main.scrollTop = 0;
    for (const element of main.querySelectorAll<HTMLElement>("*")) {
      if (element.scrollTop !== 0) element.scrollTop = 0;
    }
  }, [pathname]);
  const console_ = pathname.startsWith("/admin");
  const workspace = pathname.startsWith("/organization");
  const viewportLocked =
    pathname === "/chat" ||
    pathname === "/practice/listening" ||
    pathname === "/practice/reading" ||
    pathname === "/practice/writing" ||
    pathname === "/exam";
  /* The homepage is full-bleed, and on a large screen it is also locked to one
     viewport (above). That lock is deliberately only applied where the rail is:
     locking a narrow window makes the legal footer take height from the card
     grid, the hero collapses, and the final study cards end up behind a
     separate inner scroller. The media query lives in app/globals.css against
     [data-viewport-locked], so the same attribute means "one screen" on a
     laptop and nothing at all on a phone. */
  const fullBleed = pathname === "/" || viewportLocked;

  useEffect(() => {
    if (!viewportLocked) return;
    document.body.setAttribute("data-viewport-locked", "");
    return () => {
      document.body.removeAttribute("data-viewport-locked");
    };
  }, [viewportLocked]);

  /*
    The dashboard is one screen, at the owner's ask — but only where it can be.

    Its own attribute rather than data-viewport-locked, because that one locks
    at every width and this must not. With the rail beside it the page is four
    modules two by two and genuinely fits; without the rail it is the tile stack
    it always was, and locking that makes the legal footer take height from the
    grid, collapses the hero, and puts the last study cards behind a second
    inner scroller. So the CSS for this attribute lives inside a `lg` media
    query and the same attribute means nothing on a phone.
  */
  const home = pathname === "/";
  useEffect(() => {
    if (!home) return;
    document.body.setAttribute("data-home-locked", "");
    return () => {
      document.body.removeAttribute("data-home-locked");
    };
  }, [home]);

  /*
    Every other railed page is one screen too, from `lg` up.

    The owner's rule is that nothing scrolls except the library of practice
    papers. Taken literally that is impossible — History is every sitting ever
    recorded and the guides are a reference — so this is the honest version of
    it: the *page* never scrolls. The header, the rail and the footer stay
    where they are, and a page with more in it than fits scrolls inside its own
    column instead of moving the furniture. On the pages that do fit, which is
    most of them, nothing scrolls at all and the difference is invisible.

    `/practice` is the exception the rule names, and it keeps the ordinary page
    scroll: it is a list of sixty papers, its whole shape is "keep going", and
    an inner scroller inside a page that does not move is a worse way to read a
    long list than simply reading down it.

    Below `lg` none of this applies, for the reason `data-home-locked` gives:
    without the rail these pages are a stack, and locking a stack takes the
    footer's height out of the content and hides the end of it.
  */
  const pageLocked = hasSideRail(pathname) && !viewportLocked && pathname !== "/practice" && pathname !== "/";
  useEffect(() => {
    if (!pageLocked) return;
    document.body.setAttribute("data-page-locked", "");
    return () => {
      document.body.removeAttribute("data-page-locked");
    };
  }, [pageLocked]);

  /*
    The rail stands beside the page, not inside it, so a full-bleed route keeps
    its full bleed and the exam keeps its own chrome. It draws nothing below
    `lg` and nothing on the routes that own the whole window.
  */
  const railed = hasSideRail(pathname);

  const page = (
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
            /* One more tier past 2xl, because the column used to stop growing
               at 1536px and a 2560px display was left with 512 pixels of empty
               paper down each side. 116rem grows with the root as well, so the
               measure and the type widen together rather than the text getting
               larger inside a box that stays put. It is a ceiling, not a
               target: prose caps itself far below this (see app/privacy and
               the reading passage), which is deliberate and unaffected. */
            "mx-auto w-full min-h-0 max-w-5xl flex-1 px-5 py-6 sm:py-10 lg:mx-0 lg:max-w-none lg:px-0 xl:max-w-none 2xl:max-w-none"
      }
    >
      {children}
    </main>
  );

  /*
    The footer belongs to the page column, not to the window.

    It used to be a sibling of this whole row, which put a full-width band of
    legal text under the rail — so the rail's column stopped short of the
    bottom of the screen with a hard edge across it, and the navigation looked
    like it had been cut off rather than ended. Inside the column, the rail
    runs the full height and the footer sits under the content it belongs to.

    The privacy policy lives here rather than in the menu: it is a page a
    learner visits once, if ever, while Apple needs it publicly reachable to
    accept a submission at all. A footer is where people look for it.
  */
  if (!railed) {
    return (
      <>
        {page}
        <SiteFooter />
      </>
    );
  }

  return (
    /*
      One row: rail, then page. The row is what centres the pair, so the shell's
      own `mx-auto` on the page would fight it — hence `lg:mx-0` there, and the
      width tiers move onto this wrapper instead. Below `lg` the rail renders
      nothing and this collapses back to exactly what it was.
    */
    /*
      `min-h-0` so this row can be shorter than its contents. A flex item
      defaults to `min-height: auto` — "never shrink below what is inside me" —
      so on a locked page the body was the height of the window, this row was
      the height of the page, and the overflow came straight back out through
      it. The column inside can only scroll once something above it is allowed
      to be smaller than its own content.
    */
    <div className="mx-auto flex w-full min-h-0 max-w-5xl flex-1 gap-6 px-0 lg:max-w-6xl lg:gap-7 lg:px-5 xl:max-w-7xl 2xl:max-w-[96rem] min-[1920px]:max-w-[116rem]">
      <SideRail />
      {/* `min-w-0` so a wide table inside the page cannot push the column past
          the row and squeeze the rail. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {page}
        <SiteFooter />
      </div>
    </div>
  );
}
