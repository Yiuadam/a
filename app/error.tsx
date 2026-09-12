"use client";

import { useEffect } from "react";
import Link from "next/link";

/*
  The segment-level fallback for an uncaught render error.

  Before this file existed, a bug anywhere under a page fell through to
  Next's own bare "Application error" screen — no header, no menu, no way
  back, on an app where a mock exam might be three hours into running in
  another tab. This renders inside the root layout (error.tsx wraps the
  page, not the layout above it), so SiteHeader, the account menu and the
  rest of the chrome are still on screen; this only has to fill the content
  area.

  `retry` rather than `reset` drives the button. Both are passed to this
  component — Next 16.3 made `retry` the stable, documented one, because it
  re-fetches the segment inside a transition before clearing the error,
  where `reset` only clears this boundary's local state and re-renders the
  same props. For a page that broke on bad or stale data, `reset` alone
  would often throw again immediately; `retry` is the one actually named
  "try again" in the docs' own example.
*/

type ErrorPageProps = {
  error: Error & { digest?: string };
  reset: () => void;
  retry: () => void;
};

export default function Error({ error, retry }: ErrorPageProps) {
  useEffect(() => {
    // No user data here deliberately — this reaches the browser console,
    // which is not a safe place for anything beyond the error itself.
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-2.5 sm:space-y-4">
      <h1 className="text-[1.3125rem] font-semibold tracking-tight text-slate-900 sm:text-[1.625rem]">
        Something went wrong on this page
      </h1>

      <section className="card !p-4 sm:!p-6">
        <p className="text-[0.9375rem] leading-7 text-slate-700">
          This page ran into a problem while it was rendering. It is usually temporary — try
          again, or carry on from the home page or Practice below.
        </p>

        {error.digest && (
          <p className="mt-2 text-xs text-slate-400">
            If this keeps happening, mention this reference: {error.digest}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => retry()} className="btn-primary">
            Try again
          </button>
        </div>

        <ul className="mt-4 space-y-2.5">
          <li>
            <Link
              href="/"
              className="card hub-menu-card flex items-center gap-3 !px-4 !py-3 active:translate-y-px"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[0.9375rem] font-semibold text-slate-900">Home</span>
                <span className="mt-0.5 block text-[0.8125rem] leading-5 text-slate-500">
                  Your dashboard and your plan
                </span>
              </span>
              <span aria-hidden="true" className="shrink-0 text-slate-300">
                ›
              </span>
            </Link>
          </li>
          <li>
            <Link
              href="/practice"
              className="card hub-menu-card flex items-center gap-3 !px-4 !py-3 active:translate-y-px"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[0.9375rem] font-semibold text-slate-900">
                  Practice
                </span>
                <span className="mt-0.5 block text-[0.8125rem] leading-5 text-slate-500">
                  Reading, listening, writing and speaking papers
                </span>
              </span>
              <span aria-hidden="true" className="shrink-0 text-slate-300">
                ›
              </span>
            </Link>
          </li>
        </ul>
      </section>
    </div>
  );
}
