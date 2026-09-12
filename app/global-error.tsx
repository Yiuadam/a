"use client";

import { useEffect } from "react";
import Link from "next/link";
import "./globals.css";

/*
  The last resort: only reached if the root layout itself throws, which
  app/error.tsx cannot catch because error.tsx sits inside the layout, not
  above it. Next requires this file to supply its own <html> and <body> —
  it replaces the whole document, SiteHeader included — so there is no
  chrome left to lean on and everything shown here has to be self-contained.

  It still imports globals.css and reuses the app's own classes rather than
  inline styles, because the Next docs are explicit that a global-error
  document does not inherit the app's stylesheet or theme on its own. Warm
  is this app's default palette with no `data-theme` attribute needed, so
  omitting one here still renders the same cream-and-clay look rather than
  the browser's unstyled default — it just will not follow a visitor's own
  light/dark choice, which is a fair trade for a screen this rare.
*/

type GlobalErrorPageProps = {
  error: Error & { digest?: string };
  reset: () => void;
  retry: () => void;
};

export default function GlobalError({ error, retry }: GlobalErrorPageProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col items-center justify-center px-4 antialiased">
        <div className="mx-auto w-full max-w-md space-y-2.5 sm:space-y-4">
          <h1 className="text-[1.3125rem] font-semibold tracking-tight text-slate-900 sm:text-[1.625rem]">
            Something went wrong
          </h1>

          <section className="card !p-4 sm:!p-6">
            <p className="text-[0.9375rem] leading-7 text-slate-700">
              BandUp ran into a problem it could not recover from on its own. It is usually
              temporary — try again, or start again from the home page.
            </p>

            {error.digest && (
              <p className="mt-2 text-xs text-slate-400">
                If this keeps happening, mention this reference: {error.digest}
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-4">
              <button type="button" onClick={() => retry()} className="btn-primary">
                Try again
              </button>
              <Link
                href="/"
                className="text-sm font-medium text-indigo-700 underline underline-offset-4"
              >
                Home
              </Link>
              <Link
                href="/practice"
                className="text-sm font-medium text-indigo-700 underline underline-offset-4"
              >
                Practice
              </Link>
            </div>
          </section>
        </div>
      </body>
    </html>
  );
}
