"use client";

import Link from "next/link";
import type { Route } from "next";

/*
  The console's frame: the dark rail on a wide screen, a title bar on a narrow
  one, and the page beside or below it.

  The sidebar is dark against a light page on purpose, and it is the only place
  in BandUp that is. The app is warm and quiet because a learner spends hours
  in it; a console is glanced at, and the contrast is what makes "am I in the
  admin area" answerable from the corner of an eye.

  Below `lg` the rail is gone and so is the room for it — which is exactly why
  the console is four screens on a phone rather than one. The rail's job there
  is done by the back link in the title bar.
*/

export default function ConsoleShell({
  title,
  lead,
  back,
  children,
}: {
  title: string;
  lead?: string;
  /** Where the ‹ goes. Absent on the overview, which is the top of the console. */
  back?: { href: Route; label: string };
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[100dvh]">
      <aside className="hidden w-60 shrink-0 flex-col bg-slate-900 px-4 py-6 lg:flex">
        <Link href="/" className="flex items-center gap-2 px-2 text-white">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-sm font-semibold">
            B
          </span>
          <span className="text-[15px] font-semibold tracking-tight">BandUp</span>
        </Link>

        <p className="mt-8 px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Site
        </p>
        {/*
          The four screens the console has, as links rather than one label and
          three absences. On a wide screen the overview shows all of it inline
          anyway, so these are shortcuts; on a laptop narrow enough to lose the
          rail they are the only way between screens other than the back link.
        */}
        <nav className="mt-2 flex flex-col gap-0.5">
          {CONSOLE_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`rounded-lg px-3 py-2 text-sm transition-colors ${
                item.title === title
                  ? "bg-white/10 font-medium text-white"
                  : "text-slate-400 hover:bg-white/5 hover:text-white"
              }`}
            >
              {item.title}
            </Link>
          ))}
        </nav>

        <div className="mt-auto px-2">
          <Link
            href="/"
            className="text-xs text-slate-400 underline underline-offset-4 hover:text-white"
          >
            Back to the app
          </Link>
        </div>
      </aside>

      <div className="min-w-0 flex-1 px-4 py-5 sm:px-7 sm:py-6">
        <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <div className="min-w-0">
            {back && (
              <Link
                href={back.href}
                className="inline-flex items-center gap-1 text-[13px] font-medium text-slate-500 transition-colors hover:text-slate-900 lg:hidden"
              >
                <span aria-hidden="true">‹</span> {back.label}
              </Link>
            )}
            <h1 className="text-[21px] font-semibold tracking-tight text-slate-900 sm:text-[24px]">
              {title}
            </h1>
            {lead && <p className="mt-0.5 text-[13px] text-slate-500">{lead}</p>}
          </div>
          {!back && (
            <Link href="/" className="text-[13px] text-slate-500 underline underline-offset-4 lg:hidden">
              Back to the app
            </Link>
          )}
        </header>

        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

export const CONSOLE_NAV: { href: Route; title: string; detail: string }[] = [
  { href: "/admin", title: "Overview", detail: "The four numbers, at a glance" },
  { href: "/admin/traffic", title: "Signups and usage", detail: "Thirty days, as charts" },
  { href: "/admin/site", title: "Site status", detail: "Open the site, or close it" },
  { href: "/admin/config", title: "Configuration", detail: "What is wired up, and what isn't" },
];

/*
  The same answer a stranger gets, for the same reason the API returns 404: a
  page that said "you are not an admin" would confirm there is an admin page to
  find.
*/
export function NotFound({ mayNeedSignIn }: { mayNeedSignIn: boolean }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-[22px] font-semibold text-slate-900">Page not found</h1>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        {mayNeedSignIn ? "You may need to sign in." : "There's nothing at this address."}
      </p>
      <Link href="/" className="btn-secondary mt-5 inline-block">
        Back to BandUp
      </Link>
    </div>
  );
}
