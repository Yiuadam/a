import type { Metadata } from "next";
import Link from "next/link";

/*
  Who and what sit behind BandUp.

  This is an About page rather than a Credits page: its main purpose is to
  explain the product, its founder and the technology behind it. "Credits" is
  better reserved for acknowledgements and a list of contributors.

  It remains a server component so the static content and route metadata ship
  without client-side JavaScript.
*/

export const metadata: Metadata = {
  title: "About BandUp",
  description: "Who created BandUp, what it is built with, and what it is not.",
  alternates: { canonical: "https://bandup.life/about" },
};

const BUILT_WITH: { name: string; what: string }[] = [
  { name: "Next.js and React", what: "the app itself" },
  { name: "Cloudflare Workers", what: "where it runs" },
  { name: "Supabase", what: "accounts and progress" },
  { name: "Claude, by Anthropic", what: "marking and the tutor" },
  { name: "Whisper", what: "speech, on your device" },
  { name: "Tailwind CSS", what: "the look of it" },
];

export default function AboutPage() {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-2.5 sm:space-y-4">
      <h1 className="text-[21px] font-semibold tracking-tight text-slate-900 sm:text-[26px]">
        About BandUp
      </h1>

      <section className="card !p-4 sm:!p-6">
        <h2 className="mb-1.5 text-[15px] font-semibold text-slate-900">
          Founded and made by Adam
        </h2>
        <p className="text-[14px] leading-[22px] text-slate-600">
          BandUp was founded, designed, built and written by{" "}
          <strong className="font-semibold text-slate-900">Adam</strong> — one person, not a
          company. Every test, explanation and word of it is written from scratch, so anything
          wrong or unfair is his to fix, and can be fixed the week you say so.
        </p>
      </section>

      <section className="card !p-4 sm:!p-6">
        <h2 className="mb-1.5 text-[15px] font-semibold text-slate-900">Built with</h2>
        <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5">
          {BUILT_WITH.map((tool) => (
            <li key={tool.name} className="text-[13px] leading-5">
              <span className="block font-medium text-slate-900">{tool.name}</span>
              <span className="block text-slate-500">{tool.what}</span>
            </li>
          ))}
        </ul>
      </section>

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
