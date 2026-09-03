"use client";

import IntentPrefetchLink from "@/components/IntentPrefetchLink";
import CardIcon from "@/components/CardIcon";
import { Icon } from "@/components/Icons";

/*
  The phone home page's six tiles, on a board that otherwise never shows them.

  Below `lg`, app/page.tsx draws "Practise a skill" and "Study the language
  itself" directly — two full-width sections the phone has the height for. On
  a laptop those sections are gone (see the note beside <Board> there: naming
  the same six places twice, once as tiles and once in the permanent rail,
  is what left a 1080px screen empty underneath a single row of them), and
  the rail names every skill in a menu that is always present — but a menu
  in the corner of the eye and six tiles in the middle of the page are not
  the same thing, and a learner arranging their own board had no way to ask
  for the second one back. This is that: the same six destinations, in one
  card, sized to the board's own grid rather than the phone's full width.

  ---------------------------------------------------------------------------
  Why one card of six rather than the phone's own two sections

  The phone's version is two headed sections because it has a whole screen's
  height to spend and reads top to bottom. A board module gets one grid cell
  — roughly a quarter of the screen a learner is looking at — and two section
  headings plus six full-width rows would either need to scroll inside the
  card or crowd everything else off the board. A flat 3-by-2 grid of small
  tiles removes the two headings' height entirely and still reads as "the
  exam skills, and the two things you drill without a clock" from the icons
  and single-line labels alone.

  ---------------------------------------------------------------------------
  Why there is no lock preview here

  The phone tiles check access before drawing a card, so a learner sees a
  padlock without leaving the dashboard. This card does not repeat that
  check — every other board module (PlanCard, TutorCard, the Extras tiles)
  links out just as plainly and lets the destination decide, and /speaking
  and /practice/writing already draw their own lock behind SkillGate the
  moment either is opened. Duplicating the check here would be a second
  place that access decision could drift from the first; the six tiles this
  card draws are exactly the six a learner would reach from the rail anyway,
  which already makes the same promise and keeps none of it.
*/

const TILES = [
  { key: "listening", label: "Listening", href: "/practice/listening" },
  { key: "reading", label: "Reading", href: "/practice/reading" },
  { key: "writing", label: "Writing", href: "/practice/writing" },
  { key: "speaking", label: "Speaking", href: "/speaking" },
  { key: "grammar", label: "Grammar", href: "/grammar" },
  { key: "vocabulary", label: "Vocabulary", href: "/vocabulary" },
] as const;

export default function SkillsCard() {
  return (
    <section
      className="card flex h-full min-w-0 flex-col overflow-hidden !p-4"
      aria-labelledby="dashboard-skills-heading"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <h2 id="dashboard-skills-heading" className="text-[0.9375rem] font-semibold text-slate-900">
          Practise or study
        </h2>
        <CardIcon name="practice" size={20} />
      </div>

      {/*
        `min-h-0` on the grid, not just on its ancestors — a flex item's
        default minimum height is its content's, so without it a tall enough
        card pushed the grid past its own share of `flex-1` instead of
        stopping there, and the tiles below the fold were the ones a short
        window clipped rather than scrolled to.
      */}
      <div className="mt-3 grid min-h-0 flex-1 grid-cols-3 gap-2">
        {TILES.map((tile) => (
          <IntentPrefetchLink
            key={tile.key}
            href={tile.href}
            className="dashboard-skills-tile flex min-w-0 flex-col items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-surface px-1.5 py-2 text-center transition-colors hover:border-indigo-200 hover:bg-indigo-50/60"
          >
            <Icon name={tile.key} className="h-5 w-5 shrink-0 text-indigo-600" />
            <span className="min-w-0 truncate text-[0.75rem] font-medium leading-none text-slate-800">
              {tile.label}
            </span>
          </IntentPrefetchLink>
        ))}
      </div>
    </section>
  );
}
