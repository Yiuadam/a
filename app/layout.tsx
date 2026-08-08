import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import LookupProvider from "@/components/Lookup";
import ThemeToggle from "@/components/ThemeToggle";
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
  { href: "/practice", label: "Practice" },
  { href: "/grammar", label: "Grammar" },
  { href: "/vocabulary", label: "Vocabulary" },
  { href: "/speaking", label: "Speaking" },
  { href: "/resources", label: "Guides" },
] as const;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      data-theme="warm"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        {/*
          The header has to survive a narrow phone with seven destinations in
          it. The logo and the theme toggle are pinned and never shrink; the
          nav between them takes whatever is left and scrolls inside itself, so
          a long list of links can never widen the page. The wordmark is hidden
          on the smallest screens to hand those pixels to the nav.
        */}
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-slate-50/85 backdrop-blur">
          <div className="mx-auto flex max-w-4xl items-center gap-2 px-4 py-3 sm:gap-3 sm:px-5">
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
            <nav className="nav-scroll no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm">
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
            {/*
              Account sits beside the theme toggle rather than in NAV, which is
              already seven items on a phone-width scroller. It is also not a
              destination in the way "Practice" is — most visits never need it,
              because everything on this app works signed out.
            */}
            <div className="flex shrink-0 items-center gap-1 sm:gap-2">
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
        <LookupProvider>
          <main data-lookupable className="mx-auto w-full max-w-5xl flex-1 px-5 py-10">
            {children}
          </main>
        </LookupProvider>
        {/*
          The privacy policy lives here rather than in NAV: the header is
          already tight at seven items on a phone, and this is a page a learner
          visits once, if ever — while Apple needs it publicly reachable to
          accept a submission at all.
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
