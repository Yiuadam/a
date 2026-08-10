"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/*
  The site footer, and the one place it does not belong.

  It was inline in the root layout. It moved here so it can decline to draw on
  /admin, which supplies its own chrome — an owner looking at a console does not
  need a reminder that band scores are estimates, and the site's own furniture
  around a full-bleed dashboard reads as two applications stacked.

  A client component only for `usePathname`. Everything in it is static.
*/

export default function SiteFooter() {
  const pathname = usePathname();
  if (pathname.startsWith("/admin")) return null;

  return (
    <footer className="mt-4 border-t border-slate-200">
      <div className="mx-auto max-w-5xl space-y-3 px-5 py-6 text-xs leading-5 text-slate-400 lg:max-w-6xl xl:max-w-7xl 2xl:max-w-[96rem]">
        {/*
          What BandUp is, on every page rather than only the one a visitor
          happens to land on. Google's OAuth review asked for it twice — once
          for a missing purpose, once for a name it could not find — and it is
          the right thing for a person arriving from a link regardless.
        */}
        <p>
          <span className="font-medium text-slate-500">BandUp</span> is free IELTS preparation: a
          placement test that finds your band, a study plan built around it, and practice in
          listening, reading, writing and speaking with an AI examiner.
        </p>
        <p>
          Band scores here are practice estimates. BandUp is an independent study tool, not
          affiliated with or endorsed by IELTS, the British Council, IDP or Cambridge English.
        </p>
        <Link
          href="/privacy"
          className="inline-block rounded text-slate-500 underline underline-offset-2 transition-colors hover:text-slate-900"
        >
          Privacy policy
        </Link>
        <span className="px-2 text-slate-400" aria-hidden>
          ·
        </span>
        <Link
          href="/terms"
          className="inline-block rounded text-slate-500 underline underline-offset-2 transition-colors hover:text-slate-900"
        >
          Terms of use
        </Link>
      </div>
    </footer>
  );
}
