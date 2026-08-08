"use client";

import Link from "next/link";
import BandBadge from "@/components/BandBadge";
import { useProfile } from "@/lib/hooks";
import { latestFor, newestFirst } from "@/lib/results";
import { markVisited } from "@/lib/store";
import type { ModuleName } from "@/lib/types";
import { Icon } from "@/components/Icons";

const MODULES: { key: ModuleName; label: string; href: string; blurb: string; icon: string }[] = [
  {
    key: "listening",
    label: "Listening",
    href: "/practice",
    blurb: "Recordings read aloud to you, then questions",
    icon: "listening",
  },
  {
    key: "reading",
    label: "Reading",
    href: "/practice",
    blurb: "Real passage types with real question styles",
    icon: "reading",
  },
  {
    key: "writing",
    label: "Writing",
    href: "/practice/writing",
    blurb: "Write an essay, get examiner-style feedback",
    icon: "writing",
  },
  {
    key: "speaking",
    label: "Speaking",
    href: "/speaking",
    blurb: "Talk to an AI examiner and get scored",
    icon: "speaking",
  },
];

/* Study sections rather than exam papers: no clock, no band, just the rule. */
const STUDY = [
  {
    href: "/grammar",
    label: "Grammar",
    blurb: "Ten topics, the rule then the drill",
    icon: "grammar",
  },
  {
    href: "/vocabulary",
    label: "Vocabulary",
    blurb: "Collocations, phrasal verbs, word families",
    icon: "vocabulary",
  },
];

export default function Dashboard() {
  const profile = useProfile();
  const placement = profile.placement;

  return (
    <div className="space-y-10">
      {/* One card, one obvious next step. */}
      <section className="card flex flex-col items-start gap-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-md space-y-3">
          <h1 className="text-[26px] font-semibold leading-snug text-slate-900">
            {placement ? "Welcome back." : "Let's find your band score."}
          </h1>
          <p className="text-[15px] leading-7 text-slate-600">
            {placement
              ? `You're around band ${placement.band}. Your plan tells you exactly what to do next — no guessing.`
              : "One short test, five minutes, and you'll know where you stand. Then we build a study plan around your weak spots."}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            {placement ? (
              <>
                <Link href="/plan" className="btn-primary">
                  See what to do next
                </Link>
                <Link href="/placement" className="btn-secondary">
                  Re-test my level
                </Link>
              </>
            ) : (
              <Link href="/placement" className="btn-primary">
                Start the 5-minute test
              </Link>
            )}
          </div>
        </div>
        {placement && <BandBadge band={placement.band} caption="Your current estimate" />}
      </section>

      <section>
        <h2 className="heading-rule mb-4 text-base font-semibold text-slate-900">Practise a skill</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {MODULES.map((m) => {
            const latest = latestFor(profile.results, m.key);
            const isNew = !latest && !(profile.visited ?? []).includes(m.key);
            return (
              <Link
                key={m.key}
                href={m.href}
                /*
                  "New" means "you have not looked at this", so opening it is
                  what retires the badge — not finishing a test. Recorded on
                  the click rather than on the destination page, because the
                  four cards lead to three pages and two of them serve more
                  than one module.
                */
                onClick={() => markVisited(m.key)}
                className="card block transition-all hover:-translate-y-0.5 hover:border-indigo-300"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <Icon name={m.icon} className="mt-0.5 h-6 w-6 shrink-0 text-indigo-600" />
                    <div>
                      <h3 className="font-semibold text-slate-900">{m.label}</h3>
                      <p className="mt-1 text-sm leading-6 text-slate-600">{m.blurb}</p>
                    </div>
                  </div>
                  {latest ? (
                    <span className="shrink-0 rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
                      {latest.band}
                    </span>
                  ) : isNew ? (
                    <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">
                      New
                    </span>
                  ) : null}
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="heading-rule mb-4 text-base font-semibold text-slate-900">
          Study the language itself
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {STUDY.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              className="card block transition-all hover:-translate-y-0.5 hover:border-indigo-300"
            >
              <div className="flex items-start gap-3">
                <Icon name={s.icon} className="mt-0.5 h-6 w-6 shrink-0 text-indigo-600" />
                <div>
                  <h3 className="font-semibold text-slate-900">{s.label}</h3>
                  <p className="mt-1 text-sm leading-6 text-slate-600">{s.blurb}</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {profile.results.length > 0 && (
        <section>
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <h2 className="heading-rule flex-1 text-base font-semibold text-slate-900">Your recent practice</h2>
            <Link href="/history" className="shrink-0 text-sm font-medium text-indigo-700 underline underline-offset-2">
              All history →
            </Link>
          </div>
          <ul className="space-y-2">
            {newestFirst(profile.results).slice(0, 6).map((r, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-surface px-5 py-3.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-800">{r.testTitle}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    <span className="capitalize">{r.module}</span>
                    {r.raw !== undefined && r.total !== undefined
                      ? ` · ${r.raw} of ${r.total} correct`
                      : ""}
                    {" · "}
                    {new Date(r.date).toLocaleDateString()}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-indigo-50 px-3 py-1 text-sm font-semibold text-indigo-700">
                  Band {r.band}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
