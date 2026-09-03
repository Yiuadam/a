import type { Metadata } from "next";
import Link from "next/link";

/*
  The page a mistyped URL or a stale link lands on.

  There was no such file, so Next served its own built-in 404 — which paints
  its own near-black background regardless of theme. In Warm, the theme the app
  ships with, that put a black page behind a cream header: the wordmark and the
  whole of the navigation went dark-on-dark, so the one thing a lost learner
  needs, the way back, was the thing that disappeared.

  It is a server component with no state of its own. A 404 that needs
  JavaScript to tell you where you are is a 404 that can fail twice.
*/

export const metadata: Metadata = {
  title: "Page not found",
};

const WAYS_BACK: { href: string; label: string; detail: string }[] = [
  { href: "/practice", label: "Practice", detail: "Reading, listening, writing and speaking papers" },
  { href: "/plan", label: "Your plan", detail: "What to work on next" },
  { href: "/resources", label: "Guides", detail: "How the exam works, and how it is marked" },
];

export default function NotFound() {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-2.5 sm:space-y-4">
      <h1 className="text-[1.3125rem] font-semibold tracking-tight text-slate-900 sm:text-[1.625rem]">
        That page is not here
      </h1>

      <section className="card !p-4 sm:!p-6">
        <p className="text-[0.9375rem] leading-7 text-slate-700">
          The address may have been mistyped, or the page may have moved since the link to it was
          made. Nothing you have done has been lost — your practice and your history are exactly
          where they were.
        </p>

        <ul className="mt-4 space-y-2.5">
          {WAYS_BACK.map((way) => (
            <li key={way.href}>
              <Link
                href={way.href}
                className="card hub-menu-card flex items-center gap-3 !px-4 !py-3 active:translate-y-px"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[0.9375rem] font-semibold text-slate-900">
                    {way.label}
                  </span>
                  <span className="mt-0.5 block text-[0.8125rem] leading-5 text-slate-500">
                    {way.detail}
                  </span>
                </span>
                <span aria-hidden="true" className="shrink-0 text-slate-300">
                  ›
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
