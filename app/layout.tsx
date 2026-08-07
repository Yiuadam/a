import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import LookupProvider from "@/components/Lookup";
import NavLinks from "@/components/NavLinks";
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
              <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-sm font-bold text-accent-fg shadow-sm transition-transform group-hover:-rotate-6">
                B
              </span>
              <span className="hidden xs:inline">BandUp</span>
            </Link>
            <NavLinks items={NAV} />
            <div className="shrink-0">
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
          </div>
        </footer>
      </body>
    </html>
  );
}
