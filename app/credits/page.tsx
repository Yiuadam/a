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
*/

export const metadata: Metadata = {
  title: "Credits — BandUp",
  description: "Who made BandUp, what it is built with, and what it is not.",
};

const BUILT_WITH: { name: string; what: string }[] = [
  { name: "Next.js and React", what: "the app itself" },
  { name: "Cloudflare Workers", what: "where it runs" },
  { name: "Supabase", what: "accounts and saved progress" },
  { name: "Claude, by Anthropic", what: "the marking, the examiner and the tutor" },
  { name: "Whisper", what: "turning speech into text on your own device" },
  { name: "Tailwind CSS", what: "the look of it" },
];

export default function CreditsPage() {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-[26px] font-semibold text-slate-900">Credits</h1>
        <p className="text-[15px] leading-7 text-slate-600">
          Who made BandUp, and what it is made of.
        </p>
      </div>

      <section className="card">
        <h2 className="heading-rule mb-2 text-base font-semibold text-slate-900">
          Made by Adam
        </h2>
        <p className="text-[15px] leading-7 text-slate-600">
          BandUp is designed, built and written by <strong className="font-semibold text-slate-900">Adam</strong> —
          one person, not a company. Every practice test, every explanation, every word of the
          study material is written from scratch for this app.
        </p>
        <p className="mt-2 text-[15px] leading-7 text-slate-600">
          If something is wrong, unclear or unfair, it is his to fix. There is no team to pass it
          to, which is the point: the app can be changed the same week you complain about it.
        </p>
      </section>

      <section className="card">
        <h2 className="heading-rule mb-2 text-base font-semibold text-slate-900">
          Built with
        </h2>
        <ul className="space-y-1.5">
          {BUILT_WITH.map((tool) => (
            <li key={tool.name} className="flex gap-2.5 text-[15px] leading-7 text-slate-700">
              <span
                aria-hidden="true"
                className="mt-3 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-600"
              />
              <span>
                <span className="font-medium text-slate-900">{tool.name}</span>
                <span className="text-slate-600"> — {tool.what}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/*
        The disclaimer belongs here as much as in the footer. Somebody who has
        opened a page called "Credits" is asking who stands behind this, and
        that question deserves the honest half of the answer as well.
      */}
      <section className="card">
        <h2 className="heading-rule mb-2 text-base font-semibold text-slate-900">
          What BandUp is not
        </h2>
        <p className="text-[15px] leading-7 text-slate-600">
          It is an independent study tool. It is not affiliated with, endorsed by or connected to
          IELTS, the British Council, IDP or Cambridge English, and no band score it gives you is
          an official one — they are practice estimates, made to help you decide what to work on
          next.
        </p>
        <p className="mt-2 text-[15px] leading-7 text-slate-600">
          The practice material here is original. Nothing is copied from published IELTS papers.
        </p>
      </section>

      <p className="text-sm text-slate-500">
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
