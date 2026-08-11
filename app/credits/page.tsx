import type { Metadata } from "next";
import Link from "next/link";

/*
  Who made this.

  A server component, so it can carry its own metadata — the same reason
  app/privacy/page.tsx is one. It holds no state and does nothing on the
  client, so there is no reason for it to ship any JavaScript at all.

  It sits in the menu rather than the header row: it is a page somebody reads
  once, and the header is already carrying the five things a learner opens
  every day.

  ---------------------------------------------------------------------------
  Written to fit a phone

  It ran 1673 pixels on a 390-wide screen — three cards of full-width prose for
  what is, in total, about a hundred and thirty words of fact. Read-once pages
  are the easiest ones to leave long, because nobody complains about a page
  they visit twice.

  Nothing here is cut. The tools are a two-column list instead of a column,
  because a name and four words do not need the width of a screen each; the
  three paragraphs that said the same thing twice now say it once. What is
  deliberately untouched is the disclaimer — every clause of "not affiliated,
  not official, nothing copied" is load-bearing, and this is the page somebody
  reads it on.
*/

export const metadata: Metadata = {
  title: "Credits — BandUp",
  description: "Who made BandUp, what it is built with, and what it is not.",
};

const BUILT_WITH: { name: string; what: string }[] = [
  { name: "Next.js and React", what: "the app itself" },
  { name: "Cloudflare Workers", what: "where it runs" },
  { name: "Supabase", what: "accounts and progress" },
  { name: "Claude, by Anthropic", what: "marking and the tutor" },
  { name: "Whisper", what: "speech, on your device" },
  { name: "Tailwind CSS", what: "the look of it" },
];

export default function CreditsPage() {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-2.5 sm:space-y-4">
      <h1 className="text-[21px] font-semibold tracking-tight text-slate-900 sm:text-[26px]">
        Credits
      </h1>

      <section className="card !p-4 sm:!p-6">
        <h2 className="mb-1.5 text-[15px] font-semibold text-slate-900">Made by Adam</h2>
        <p className="text-[14px] leading-[22px] text-slate-600">
          Designed, built and written by{" "}
          <strong className="font-semibold text-slate-900">Adam</strong> — one person, not a
          company. Every test, explanation and word of it is written from scratch, so anything
          wrong or unfair is his to fix, and can be fixed the week you say so.
        </p>
      </section>

      <section className="card !p-4 sm:!p-6">
        <h2 className="mb-1.5 text-[15px] font-semibold text-slate-900">Built with</h2>
        {/* Two columns from the narrowest screen up: a tool name and four
            words describing it do not each need the width of a phone. */}
        <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5">
          {BUILT_WITH.map((tool) => (
            <li key={tool.name} className="text-[13px] leading-5">
              <span className="block font-medium text-slate-900">{tool.name}</span>
              <span className="block text-slate-500">{tool.what}</span>
            </li>
          ))}
        </ul>
      </section>

      {/*
        The disclaimer belongs here as much as in the footer. Somebody who has
        opened a page called "Credits" is asking who stands behind this, and
        that question deserves the honest half of the answer as well.
      */}
      <section className="card !p-4 sm:!p-6">
        <h2 className="mb-1.5 text-[15px] font-semibold text-slate-900">What BandUp is not</h2>
        <p className="text-[14px] leading-[22px] text-slate-600">
          An independent study tool — not affiliated with, endorsed by or connected to IELTS, the
          British Council, IDP or Cambridge English. No band it gives you is official; they are
          practice estimates, to help you decide what to work on next. Every word of the material
          is original, copied from no published paper.
        </p>
      </section>

      <p className="pt-0.5 text-[12px] text-slate-500">
        <Link href="/privacy" className="font-medium text-indigo-700 underline underline-offset-2">
          Privacy policy
        </Link>
        {" · "}
        <Link href="/terms" className="font-medium text-indigo-700 underline underline-offset-2">
          Terms
        </Link>
      </p>
    </div>
  );
}
