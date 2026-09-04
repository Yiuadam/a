import Link from "next/link";
import { Icon } from "@/components/Icons";
import { SKILL_GUIDES } from "@/lib/guides";

/*
  The reference sections, as the overview lists them. Titles and one line each;
  the sections themselves live at /resources/reference.
*/
const REFERENCE: Array<[string, string, string]> = [
  ["bands", "What the bands mean", "1 to 9 per skill, and what each one describes."],
  ["conversion", "Raw score to band", "Out of 40, for listening and reading."],
  ["question-types", "Question types", "Every type the papers can ask."],
  ["on-the-day", "On the day", "How the computer test actually runs."],
];

export default function ResourcesPage() {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-80">
          <h1 className="text-xl font-semibold text-slate-900 sm:text-[1.375rem]">Exam guides</h1>
          <p className="text-sm leading-6 text-slate-600">
            What each part of the test asks of you, and the habits that move your score most.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/practice" className="btn-primary">
            Take a practice test
          </Link>
          <Link href="/speaking" className="btn-secondary">
            Try the speaking examiner
          </Link>
        </div>
      </div>

      {/*
        The four guides first, as buttons, then the reference cards.

        Two plain grids, and no `order-*` or `col-span` between them. The
        previous version put a two-column block inside a three-column grid and
        reordered the pieces around it, which held together only while there
        were exactly two things in the left column — adding a third dropped the
        raw-score table into a cell it did not fit and clipped it halfway down.
        A layout that has to be counted before it can be changed is the wrong
        layout for a page that gains sections.
      */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/*
          Four buttons, not four drawers.

          Opened, the drawers put twenty-two paragraphs of advice on a page
          whose job is to show what there is; closed, they made somebody click
          four times before reading anything. A button says what is inside and
          costs one click to get there, and the advice gets a page with room
          for it — see app/resources/[skill]/page.tsx.
          */}
        {SKILL_GUIDES.map((guide) => (
          <Link
            key={guide.slug}
            href={`/resources/${guide.slug}`}
            className="card !p-4 group flex h-fit min-w-0 items-center gap-2.5"
          >
            <Icon name={guide.icon} className="h-5 w-5 shrink-0 text-indigo-600" strokeWidth={1.6} />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-slate-900">{guide.title}</span>
              <span className="block text-xs text-slate-500">
              {guide.time} · {guide.tips.length} tips
              </span>
            </span>
            <span aria-hidden className="shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5">
              ›
            </span>
          </Link>
          ))}

      </div>

      {/*
        The reference, as four more buttons rather than four long cards.

        They were the whole of it printed on this page: two screens of prose
        under a row of buttons that were the actual navigation, so the page
        stopped being an overview about a third of the way down. Same content,
        one page over, and this one stays a list of what there is.
      */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {REFERENCE.map(([anchor, title, what]) => (
          <Link
            key={anchor}
            href={`/resources/reference#${anchor}`}
            className="card !p-4 group flex h-fit min-w-0 items-center gap-2.5"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-slate-900">{title}</span>
              <span className="block text-xs leading-5 text-slate-500">{what}</span>
            </span>
            <span
              aria-hidden
              className="shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5"
            >
              ›
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
