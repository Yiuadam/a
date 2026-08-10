import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import LookupProvider from "@/components/Lookup";
import AutoSync from "@/components/AutoSync";
import Maintenance from "@/components/Maintenance";
import SiteHeader from "@/components/SiteHeader";
import { MAINTENANCE_MODE } from "@/lib/maintenance";
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
          Closed for maintenance: the app is replaced rather than covered.

          An overlay would have been less code and the wrong thing. A learner
          can dismiss an overlay with the element inspector, a screen reader
          walks straight past it into the app underneath, and the page behind it
          still runs — fetching, syncing, spending an allowance. Replacing the
          tree means there is nothing behind it to reach.

          The header and footer go with it. They are navigation, and offering
          navigation to a site that is closed is offering nine ways to find the
          same notice.

          API routes are untouched, which is the point of gating here rather
          than in front of the whole deployment: Stripe's webhooks keep
          arriving, so renewals and cancellations for existing subscribers are
          still recorded while the shop is shut.
        */}
        {MAINTENANCE_MODE ? (
          <Maintenance />
        ) : (
        <>
        <SiteHeader />
        {/*
          `data-lookupable` on <main> means any word a learner selects anywhere
          in the app — a passage, a transcript, a question, an explanation — can
          be looked up without leaving the page.
        */}
        {/* Renders nothing; keeps a signed-in account's progress current. */}
        <AutoSync />
        <LookupProvider>
          {/*
            The shell grows with the screen instead of stopping at 1024px.

            It used to be max-w-5xl at every width, which on a 2560px display
            left 31% of the screen empty and the app sitting in a column down
            one side. Now it steps up: 1024 to lg, then 1152, 1280, and 1536 on
            a very wide monitor.

            It does not go to full bleed, and that is the whole judgement here.
            Line length is not a style preference — prose past about 90
            characters is measurably harder to read, because the eye loses the
            start of the next line on the way back. So the shell widens for
            things that come in columns (cards, lists, grids, which get more
            columns as it grows) while every page with real prose in it keeps
            its own inner max-w-xl. Widening the container and letting a
            paragraph run 1500px would be worse than the empty space it fixed.
          */}
          <main
            data-lookupable
            className="mx-auto w-full max-w-5xl flex-1 px-5 py-10 lg:max-w-6xl xl:max-w-7xl 2xl:max-w-[96rem]"
          >
            {children}
          </main>
        </LookupProvider>
        {/*
          The privacy policy lives here rather than in the menu: it is a page a
          learner visits once, if ever, while Apple needs it publicly reachable
          to accept a submission at all. A footer is where people look for it.
        */}
        <footer className="mt-4 border-t border-slate-200">
          <div className="mx-auto max-w-5xl space-y-3 px-5 py-6 text-xs leading-5 text-slate-400 lg:max-w-6xl xl:max-w-7xl 2xl:max-w-[96rem]">
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
        </>
        )}
      </body>
    </html>
  );
}
