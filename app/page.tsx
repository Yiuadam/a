"use client";

import Link from "next/link";
import BandBadge from "@/components/BandBadge";
import { useProfile } from "@/lib/hooks";
import type { ModuleName } from "@/lib/types";

const MODULES: { key: ModuleName; label: string; href: string; blurb: string; icon: string }[] = [
  {
    key: "listening",
    label: "Listening",
    href: "/practice",
    blurb: "Recordings read aloud to you, then questions",
    icon: "🎧",
  },
  {
    key: "reading",
    label: "Reading",
    href: "/practice",
    blurb: "Real passage types with real question styles",
    icon: "📖",
  },
  {
    key: "writing",
    label: "Writing",
    href: "/practice/writing",
    blurb: "Write an essay, get examiner-style feedback",
    icon: "✍️",
  },
  {
    key: "speaking",
    label: "Speaking",
    href: "/speaking",
    blurb: "Talk to an AI examiner and get scored",
    icon: "🗣️",
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
            const latest = profile.results.find((r) => r.module === m.key);
            return (
              <Link
                key={m.key}
                href={m.href}
                className="card block transition-all hover:-translate-y-0.5 hover:border-indigo-300"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <span className="text-2xl" aria-hidden>
                      {m.icon}
                    </span>
                    <div>
                      <h3 className="font-semibold text-slate-900">{m.label}</h3>
                      <p className="mt-1 text-sm leading-6 text-slate-600">{m.blurb}</p>
                    </div>
                  </div>
                  {latest ? (
                    <span className="shrink-0 rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
                      {latest.band}
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">
                      New
                    </span>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      {profile.results.length > 0 && (
        <section>
          <h2 className="heading-rule mb-4 text-base font-semibold text-slate-900">Your recent practice</h2>
          <ul className="space-y-2">
            {profile.results.slice(0, 6).map((r, i) => (
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
