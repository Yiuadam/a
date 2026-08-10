import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import LookupProvider from "@/components/Lookup";
import AutoSync from "@/components/AutoSync";
import Maintenance from "@/components/Maintenance";
import AppMain from "@/components/AppMain";
import SiteFooter from "@/components/SiteFooter";
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
  /*
    Build-time only, for now.

    The runtime switch — a row the owner writes from /admin, read here on each
    render — made every page of the preview answer 500 while /api kept working,
    which is exactly the shape of a fault in this function: the layout is the
    only thing a page has that a route handler does not.

    It could not be reproduced locally in five configurations, including the
    full production environment against a stub answering what Supabase answers.
    So it is out until it can be, rather than shipped on the hope that the
    hardening around it is enough. A switch that closes the site is not a thing
    to leave a maybe in.

    Everything else the switch needs is still here and still works: the row, the
    two functions, the admin screen, the API that writes it. Only this read is
    withdrawn, and closing the site stays a deploy in the meantime.
  */
  const closed = MAINTENANCE_MODE;

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
        {closed ? (
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
          <AppMain>{children}</AppMain>
        </LookupProvider>
        {/*
          The privacy policy lives here rather than in the menu: it is a page a
          learner visits once, if ever, while Apple needs it publicly reachable
          to accept a submission at all. A footer is where people look for it.
        */}
        <SiteFooter />
        </>
        )}
      </body>
    </html>
  );
}
