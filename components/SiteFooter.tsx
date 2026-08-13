"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IS_MOBILE_BUILD } from "@/lib/platform";

/*
  The site footer, and the one place it does not belong.

  It was inline in the root layout. It moved here so it can decline to draw on
  /admin, which supplies its own chrome — an owner looking at a console does not
  need a reminder that band scores are estimates, and the site's own furniture
  around a full-bleed dashboard reads as two applications stacked.

  A client component only for `usePathname`. Everything in it is static.
*/

/*
  Where the "what BandUp is" paragraph belongs.

  It went on every page to answer Google's OAuth review, which asked twice —
  once for a missing statement of purpose, once for a product name it could not
  find. Those are questions a *visitor* has, and a visitor arrives on one of
  these: the front page, the plans, About BandUp, or a legal page they followed
  a link to.

  On the screens inside the app it is answering a question nobody has. Somebody
  looking at their own usage bars knows what BandUp is; the paragraph is two
  hundred pixels of a 844-pixel phone spent telling them. So it stays where it
  is read and steps out of the way where it is not — not hidden by a
  breakpoint, which would answer a reviewer in a viewport they never open, but
  absent from pages a reviewer has no reason to visit.

  The disclaimer is different and stays everywhere: "band scores here are
  practice estimates, this is not affiliated with IELTS" is a claim about what
  the number on the screen means, and the screens inside the app are exactly
  where those numbers are.
*/
const INTRODUCES_ITSELF = IS_MOBILE_BUILD
  ? /* No /pricing in the iOS bundle to be a landing page: build-mobile.mjs
       removes the route entirely, because the app sells nothing. */
    ["/", "/resources"]
  : ["/", "/pricing", "/resources"];

/*
  Pages that already say all of it themselves.

  /about and the two legal pages carry the same two statements in full, in
  their own words, as the substance of the page. Repeating them in the footer
  is the same sentence twice on one screen — which reads as boilerplate and
  makes the copy above it look like boilerplate too. So these keep the links
  and nothing else.
*/
const SAYS_IT_ITSELF = ["/about", "/credits", "/privacy", "/terms"];

export default function SiteFooter() {
  const pathname = usePathname();
  const immersive =
    pathname.startsWith("/admin") ||
    pathname.startsWith("/organization") ||
    pathname === "/chat" ||
    pathname === "/practice/listening" ||
    pathname === "/practice/reading" ||
    pathname === "/practice/writing" ||
    pathname === "/account/profile" ||
    pathname === "/exam";
  if (immersive) return null;
  const introduce = INTRODUCES_ITSELF.includes(pathname);
  const disclaim = !SAYS_IT_ITSELF.includes(pathname);

  return (
    <footer className="mt-2 border-t border-slate-200 sm:mt-4">
      {/*
        Tighter on a phone, and only there. The words are the same words —
        Google's OAuth review asked for this description twice and hiding it
        from the small screen would be answering them in a viewport nobody
        checks — but at 11px on a 16px rhythm they cost about eighty pixels
        instead of two hundred and thirty, which is the difference between a
        menu that ends on the screen and one that does not.
      */}
      <div className="mx-auto max-w-5xl space-y-2 px-5 py-4 text-[11px] leading-4 text-slate-400 sm:space-y-3 sm:py-6 sm:text-xs sm:leading-5 lg:max-w-6xl xl:max-w-7xl 2xl:max-w-[96rem]">
        {introduce && (
          <p>
            <span className="font-medium text-slate-500">BandUp</span> is free IELTS preparation: a
            placement test that finds your band, a study plan built around it, and practice in
            listening, reading, writing and speaking with an AI examiner.
          </p>
        )}
        {disclaim && (
          <p>
            Band scores here are practice estimates. BandUp is an independent study tool, not
            affiliated with or endorsed by IELTS, the British Council, IDP or Cambridge English.
          </p>
        )}
        <Link
          href="/privacy"
          prefetch={false}
          className="inline-block rounded text-slate-500 underline underline-offset-2 transition-colors hover:text-slate-900"
        >
          Privacy policy
        </Link>
        <span className="px-2 text-slate-400" aria-hidden>
          ·
        </span>
        <Link
          href="/terms"
          prefetch={false}
          className="inline-block rounded text-slate-500 underline underline-offset-2 transition-colors hover:text-slate-900"
        >
          Terms of use
        </Link>
      </div>
    </footer>
  );
}
