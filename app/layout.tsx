import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import LookupProvider from "@/components/Lookup";
import ThemeToggle from "@/components/ThemeToggle";
import AutoSync from "@/components/AutoSync";
import MobileNav from "@/components/MobileNav";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "BandUp — IELTS practice",
  description:
    "Find your IELTS band, follow a plan made for you, and practise all four skills with an AI examiner.",
  /*
    The tab icon. Pointed at the same file the header draws rather than a
    second copy in app/, so the mark cannot drift between the two places a
    visitor sees it. Replaces app/favicon.ico, which was still the Next.js
    logo from the starter template.
  */
  icons: { icon: "/icons/final/steps-five-mark.svg" },
};

const NAV = [
  { href: "/", label: "Home" },
  { href: "/plan", label: "My plan" },
  /*
    Next to the plan on purpose: the plan is what to do next, history is
    whether it is working.
  */
  { href: "/history", label: "History" },
  { href: "/practice", label: "Practice" },
  { href: "/grammar", label: "Grammar" },
  { href: "/vocabulary", label: "Vocabulary" },
  { href: "/speaking", label: "Speaking" },
  /*
    Beside Guides rather than beside Practice, because the two of them answer
    the same kind of moment: the learner has stopped practising and wants
    something explained rather than more to do. It sits before Guides so the
    pair of them read as one idea.
  */
  { href: "/chat", label: "Ask a tutor" },
  { href: "/resources", label: "Guides" },
] as const;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      data-theme="warm"
      /*
        The theme script in <head> rewrites data-theme from localStorage before
        React hydrates, so the attribute React finds is not the one it rendered.
        That is the intended design — it is what stops a dark-theme user seeing
        a white flash — but React reports it as a hydration mismatch on every
        page, in every theme except the default. Suppressing it here is the
        documented answer, and it is scoped to this element's own attributes.
      */
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        {/*
          Two headers in one, split at md.

          Below it, the destinations live behind a menu button — see
          components/MobileNav.tsx for why the horizontal scroller that used to
          be here was the wrong answer. Above it they sit inline as usual.

          --header-h is the header's own height, published as a custom property
          so the menu panel can hang off the bottom edge of it without either
          side hard-coding a number the other could change.
        */}
        <header
          className="sticky top-0 z-40 border-b border-slate-200 bg-slate-50/85 backdrop-blur"
          style={{ "--header-h": "3.75rem" } as React.CSSProperties}
        >
          <div className="mx-auto flex h-[var(--header-h)] max-w-4xl items-center gap-2 px-4 sm:gap-3 sm:px-5">
            <Link
              href="/"
              className="group flex shrink-0 items-center gap-2.5 text-[17px] font-semibold text-slate-900"
            >
              {/*
                The app icon, not a letter. `overflow-hidden` with the same
                radius is what rounds it: the artwork is a full-bleed square,
                the way an app icon has to be, so the corner has to be cut here
                rather than drawn into the file.

                Plain <img> rather than next/image: it is a 2 kB SVG at a fixed
                36px, so there is nothing to optimise, and next/image would
                need dangerouslyAllowSVG turned on for the whole app to serve
                it at all — widening what the image optimiser accepts, for one
                trusted logo. width and height are set so the header never
                reflows while it loads.
              */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/icons/final/steps-five-mark.svg"
                alt=""
                width={36}
                height={36}
                className="h-9 w-9 shrink-0 overflow-hidden rounded-2xl shadow-sm transition-transform group-hover:-rotate-6"
              />
              <span className="hidden xs:inline">BandUp</span>
            </Link>
            {/*
              min-w-0 keeps this from forcing the row wider than the screen if
              the list ever outgrows the space; below md it is not rendered at
              all, so the phone never sees it.
            */}
            <nav
              aria-label="Main"
              className="hidden min-w-0 flex-1 items-center gap-1 text-sm md:flex"
            >
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="shrink-0 whitespace-nowrap rounded-xl px-3 py-2 text-slate-600 transition-colors hover:bg-surface hover:text-slate-900"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            {/* Takes the space the desktop nav would have, so the account and
                theme controls stay pinned right on a phone. */}
            <div className="flex-1 md:hidden" />
            {/*
              Account sits beside the theme toggle rather than in NAV, which is
              already nine items and full. It is also not a destination in the
              way "Practice" is — most visits never need it, because everything
              on this app works signed out.
            */}
            <div className="flex shrink-0 items-center gap-1 sm:gap-2">
              <MobileNav items={NAV} />
              <Link
                href="/account"
                aria-label="Your account"
                className="rounded-xl px-2.5 py-2 text-sm text-slate-600 transition-colors hover:bg-surface hover:text-slate-900"
              >
                <svg
                  viewBox="0 0 20 20"
                  width="20"
                  height="20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <circle cx="10" cy="6.5" r="3.2" />
                  <path d="M3.8 17c0-3.3 2.8-5.4 6.2-5.4s6.2 2.1 6.2 5.4" />
                </svg>
              </Link>
              <ThemeToggle />
            </div>
          </div>
        </header>
        {/*
          `data-lookupable` on <main> means any word a learner selects anywhere
          in the app — a passage, a transcript, a question, an explanation — can
          be looked up without leaving the page.
        */}
        {/* Renders nothing; keeps a signed-in account's progress current. */}
        <AutoSync />
        <LookupProvider>
          <main data-lookupable className="mx-auto w-full max-w-5xl flex-1 px-5 py-10">
            {children}
          </main>
        </LookupProvider>
        {/*
          The privacy policy lives here rather than in NAV: the header is
          already full, and this is a page a learner visits once, if ever —
          while Apple needs it publicly reachable to accept a submission at all.
        */}
        <footer className="mt-4 border-t border-slate-200">
          <div className="mx-auto max-w-4xl space-y-3 px-5 py-6 text-xs leading-5 text-slate-400">
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
              Terms
            </Link>
          </div>
        </footer>
      </body>
    </html>
  );
}
