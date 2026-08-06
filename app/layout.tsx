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
};

const NAV = [
  { href: "/", label: "Home" },
  { href: "/plan", label: "My plan" },
  { href: "/practice", label: "Practice" },
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
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-slate-50/85 backdrop-blur">
          <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2 px-5 py-3">
            <Link
              href="/"
              className="group flex items-center gap-2.5 text-[17px] font-semibold text-slate-900"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-sm font-bold text-accent-fg shadow-sm transition-transform group-hover:-rotate-6">
                B
              </span>
              BandUp
            </Link>
            <div className="flex items-center gap-2">
              <nav className="flex items-center gap-1 text-sm">
                {NAV.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="rounded-xl px-3 py-2 text-slate-600 transition-colors hover:bg-surface hover:text-slate-900"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
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
        <footer className="mt-4 border-t border-slate-200">
          <div className="mx-auto max-w-4xl px-5 py-6 text-xs leading-5 text-slate-400">
            Band scores here are practice estimates. BandUp is an independent study tool, not
            affiliated with or endorsed by IELTS, the British Council, IDP or Cambridge English.
          </div>
        </footer>
      </body>
    </html>
  );
}
