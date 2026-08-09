"use client";

import Link from "next/link";
import BandBadge from "@/components/BandBadge";
import { useProfile } from "@/lib/hooks";
import { latestFor, newestFirst } from "@/lib/results";
import LockedCard from "@/components/LockedCard";
import { useSessionAccess } from "@/lib/entitlements/useSessions";
import { markVisited } from "@/lib/store";
import type { ModuleName } from "@/lib/types";
import { Icon } from "@/components/Icons";

const MODULES: { key: ModuleName; label: string; href: string; blurb: string; icon: string }[] = [
  {
    key: "listening",
    label: "Listening",
    /* The skill's own page, not the index. Tapping Listening and landing on a
       page listing reading and writing too is answering a wider question than
       the one that was asked. */
    href: "/practice/listening",
    blurb: "Audio played once, then questions",
    icon: "listening",
  },
  {
    key: "reading",
    label: "Reading",
    href: "/practice/reading",
    blurb: "Real passages, real question types",
    icon: "reading",
  },
  {
    key: "writing",
    label: "Writing",
    href: "/practice/writing",
    blurb: "An essay, marked like the exam",
    icon: "writing",
  },
  {
    key: "speaking",
    label: "Speaking",
    href: "/speaking",
    blurb: "Talk to an AI examiner, get a band",
    icon: "speaking",
  },
];

/* Study sections rather than exam papers: no clock, no band, just the rule. */
const STUDY = [
  {
    href: "/grammar",
    label: "Grammar",
    blurb: "Ten topics, rule then drill",
    icon: "grammar",
  },
  {
    href: "/vocabulary",
    label: "Vocabulary",
    blurb: "Collocations and word families",
    icon: "vocabulary",
  },
];

export default function Dashboard() {
  const profile = useProfile();
  const access = useSessionAccess();
  const placement = profile.placement;
  const recent = newestFirst(profile.results).slice(0, 6);

  return (
    <div className="space-y-4">
      {/*
        One card, one obvious next step — and now one row of it. The welcome
        used to be a paragraph and a 96px band badge stacked above everything
        else, which cost a third of a laptop screen before the first link.
      */}
      <section className="card !p-4 flex flex-wrap items-center justify-between gap-x-5 gap-y-3 sm:!p-5">
        <div className="min-w-0 flex-1 basis-64">
          <h1 className="text-xl font-semibold leading-snug text-slate-900 sm:text-[22px]">
            {placement ? "Welcome back." : "Let's find your band score."}
          </h1>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            {placement
              ? `Around band ${placement.band}. Your plan says what to do next.`
              : "One short test, five minutes, and you'll know where you stand."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {placement && (
            <span className="mr-1 flex items-center gap-2">
              <BandBadge band={placement.band} size="sm" />
              <span className="text-xs leading-4 text-slate-500">
                Current
                <br />
                estimate
              </span>
            </span>
          )}
          {placement ? (
            <>
              <Link href="/plan" className="btn-primary">
                See what to do next
              </Link>
              <Link href="/placement" className="btn-secondary">
                Re-test
              </Link>
            </>
          ) : (
            <Link href="/placement" className="btn-primary">
              Start the 5-minute test
            </Link>
          )}
        </div>
      </section>

      {/*
        Practice, study and history side by side on a laptop rather than three
        full-width bands stacked down the page. Below `lg` they fall back to
        stacking, but the tiles themselves stay two-up even on the narrowest
        phone — a tile is a title, one line and an icon, which fits in half a
        390px screen and halves the height of the page.
      */}
      {/*
        min-w-0 on both columns, and it is load-bearing rather than tidy.

        A grid item's automatic minimum width is its min-content, not zero. The
        left column holds a two-up card grid whose min-content is the widest
        unbreakable thing inside it, and on a 390px phone that came to 531px —
        so the column refused to shrink and 141px of it sat off the right edge
        of the screen. Nothing scrolled, because the body has no
        overflow-x: hidden and the page simply drew outside itself; the cards
        were cut in half and every automated check stayed green.

        min-w-0 removes that floor and lets the column be as narrow as the
        screen. Every grid or flex child in this app that contains a grid needs
        it, which is the same trap /practice hit at 390px.
      */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/*
          Two thirds when there is something in the third column, all three
          when there is not.

          The right column only renders once a learner has practised. Before
          that the left column was still spanning 2 of 3, so a new account got
          its six tiles squeezed into two thirds of the page with 524px of
          nothing beside them — measured at 1920px. The grid was reserving room
          for a section that had decided not to appear.
        */}
        <div
          className={`min-w-0 space-y-4 ${recent.length > 0 ? "lg:col-span-2" : "lg:col-span-3"}`}
        >
          <section>
            <h2 className="heading-rule mb-2.5 text-sm font-semibold text-slate-900">
              Practise a skill
            </h2>
            {/*
              Two-up on a phone, four-up from xl. More columns rather than
              wider cards: a tile is a title and one line, and stretching it to
              600px makes an icon with a lot of whitespace after it, not a
              better tile.
            */}
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              {MODULES.map((m) => {
                const latest = latestFor(profile.results, m.key);
                const isNew = !latest && !(profile.visited ?? []).includes(m.key);
                const skill = access[m.key];

                /*
                  The same lock as /practice, on the same skills, because a
                  learner meets these cards first. A door that is locked should
                  look locked wherever you find it — being told on the
                  dashboard that Writing is available and discovering one page
                  later that it is not is worse than never offering it.
                */
                if (skill.pending) {
                  return (
                    <div key={m.key} className="card !p-3.5 cursor-wait opacity-60" aria-busy="true">
                      <div className="flex items-start gap-2.5">
                        <Icon name={m.icon} className="mt-0.5 h-5 w-5 shrink-0 text-indigo-600" />
                        <div className="min-w-0">
                          <h3 className="text-sm font-semibold text-slate-900">{m.label}</h3>
                          <p className="mt-0.5 text-xs leading-5 text-slate-600">{m.blurb}</p>
                        </div>
                      </div>
                    </div>
                  );
                }

                if (skill.locked && skill.reason) {
                  return (
                    <LockedCard key={m.key} reason={skill.reason} label={`${m.label} practice`} fill>
                      <div className="card !p-3.5 h-full">
                        <div className="flex items-start gap-2.5">
                          <Icon name={m.icon} className="mt-0.5 h-5 w-5 shrink-0 text-indigo-600" />
                          <div className="min-w-0">
                            <h3 className="text-sm font-semibold text-slate-900">{m.label}</h3>
                            <p className="mt-0.5 text-xs leading-5 text-slate-600">{m.blurb}</p>
                          </div>
                        </div>
                      </div>
                    </LockedCard>
                  );
                }

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
                    className="card !p-3.5 block"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-start gap-2.5">
                        <Icon name={m.icon} className="mt-0.5 h-5 w-5 shrink-0 text-indigo-600" />
                        <div className="min-w-0">
                          <h3 className="text-sm font-semibold text-slate-900">{m.label}</h3>
                          <p className="mt-0.5 text-xs leading-5 text-slate-600">{m.blurb}</p>
                        </div>
                      </div>
                      {/*
                        No band on the card.

                        It used to show the last band as a bare number in a
                        pill, which nobody could read: a lone figure beside a
                        heading looks like a count of something — tests taken,
                        questions left — and a low band makes that worse,
                        because "2" reads far more like two of a thing than
                        like a score. Labelling it "Band 2" fixed the ambiguity
                        and made the card wordier for a number that is not what
                        the card is for. The card is a door into a skill;
                        History and the dashboard hero are where scores belong,
                        and both say what they mean.
                      */}
                      {isNew && (
                        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                          New
                        </span>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>

          <section>
            <h2 className="heading-rule mb-2.5 text-sm font-semibold text-slate-900">
              Study the language itself
            </h2>
            <div className="grid grid-cols-2 gap-3">
              {STUDY.map((s) => (
                <Link key={s.href} href={s.href} className="card !p-3.5 block">
                  <div className="flex items-start gap-2.5">
                    <Icon name={s.icon} className="mt-0.5 h-5 w-5 shrink-0 text-indigo-600" />
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-slate-900">{s.label}</h3>
                      <p className="mt-0.5 text-xs leading-5 text-slate-600">{s.blurb}</p>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        </div>

        {recent.length > 0 && (
          <section className="min-w-0 lg:col-span-1">
            <div className="mb-2.5 flex items-baseline justify-between gap-3">
              <h2 className="heading-rule flex-1 text-sm font-semibold text-slate-900">
                Your recent practice
              </h2>
              <Link
                href="/history"
                className="shrink-0 text-xs font-medium text-indigo-700 underline underline-offset-2"
              >
                All history →
              </Link>
            </div>
            {/*
              Six sittings in a fixed-height list. Anything older is one tap
              away in History, and the list scrolls inside itself rather than
              pushing the rest of the page down the screen.
            */}
            <ul className="max-h-[13rem] space-y-1.5 overflow-y-auto sm:max-h-[20rem]">
              {recent.map((r, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-surface px-3.5 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-800">{r.testTitle}</p>
                    <p className="text-xs text-slate-500">
                      <span className="capitalize">{r.module}</span>
                      {r.raw !== undefined && r.total !== undefined
                        ? ` · ${r.raw} of ${r.total} correct`
                        : ""}
                      {" · "}
                      {new Date(r.date).toLocaleDateString()}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-indigo-50 px-2.5 py-0.5 text-sm font-semibold text-indigo-700">
                    {r.band}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
