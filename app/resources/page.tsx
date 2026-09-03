import Link from "next/link";
import { Icon } from "@/components/Icons";
import { rawToBand } from "@/lib/band";
import { SKILL_GUIDES } from "@/lib/guides";

const BANDS = [
  { band: "9", label: "Expert", desc: "Full command. Fluent, accurate, precise." },
  { band: "8", label: "Very good", desc: "Occasional slips only. Handles complex argument well." },
  { band: "7", label: "Good", desc: "Operational command with occasional errors and misunderstandings." },
  { band: "6", label: "Competent", desc: "Generally effective, some inaccuracies. Common university entry level." },
  { band: "5", label: "Modest", desc: "Partial command. Copes with basic communication in your own field." },
  { band: "4", label: "Limited", desc: "Frequent problems with understanding and expression." },
];

/*
  Where each band starts, worked out from the app's own converter rather than
  typed in from a table somewhere.

  It is the honest version of this reference: it says what BandUp will actually
  do with a raw score, and it cannot drift away from the marking, because it is
  the marking. `rawToBand` is asked for every raw score from 0 to 40 and the
  boundaries fall out of the answers.
*/
function bandBoundaries(module: "listening" | "reading") {
  const rows: Array<{ band: number; from: number; to: number }> = [];
  for (let raw = 0; raw <= 40; raw += 1) {
    const band = rawToBand(raw, 40, module);
    const last = rows[rows.length - 1];
    if (last && last.band === band) last.to = raw;
    else rows.push({ band, from: raw, to: raw });
  }
  return rows.reverse();
}

/*
  Every question type the papers can ask, in the words the rubric uses. Not a
  syllabus — a candidate who has met all of these on screen once is not
  surprised by any of them on the day, and being surprised is what costs the
  first five minutes of a section.
*/
const QUESTION_TYPES = [
  ["Multiple choice", "One answer from A-D, or TWO or THREE letters from a longer list."],
  ["True / False / Not Given", "Does the passage say this, contradict it, or not mention it?"],
  ["Yes / No / Not Given", "The same three choices, but about the writer's own views."],
  ["Matching headings", "A heading for each paragraph, from a list with more headings than paragraphs."],
  ["Matching information", "Which paragraph contains a given fact."],
  ["Matching features", "Match a statement to a person, a place or a year."],
  ["Matching sentence endings", "Join the start of a sentence to the ending that fits."],
  ["Sentence completion", "One gap in a sentence, filled with words from the text."],
  ["Note, table and flow-chart completion", "The same gaps, set into a page of notes, a table, or a process."],
  ["Diagram, plan and map labelling", "Choose the letter on the drawing that marks a place."],
  ["Short answer", "Answer a question in your own words, within a word limit."],
];

const ON_THE_DAY = [
  ["It is one sitting", "Listening, Reading and Writing run back to back with no break. Speaking may be the same day or up to a week away."],
  ["Nothing is transferred", "On the computer test you type into the answer box as you go. There is no transfer time at the end — the ten minutes people talk about is the paper test."],
  ["The recording plays once", "Listening plays straight through. There is reading time before each part and a pause partway through the first three."],
  ["The clock does not stop", "Reading is 60 minutes for all three passages, and nobody tells you when to move on. Writing is 60 minutes for both tasks."],
  ["Flag and come back", "Every question can be marked for review and reached again from the strip at the bottom. Use it instead of staring."],
  ["Spelling counts", "A word heard correctly and spelled wrongly is marked wrong, in Listening and Reading alike. British and American spellings are both accepted."],
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

      {/* The reference cards. `items-start` so a short card stops where its
          content stops instead of stretching to the tallest in its row. */}
      <div className="grid items-start gap-3 lg:grid-cols-3">
        <section className="card !p-4 min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">What the band numbers mean</h2>
          <p className="mt-0.5 text-xs leading-5 text-slate-600">
            A band from 1 to 9 per skill, then an overall band — the average, rounded to the
            nearest half.
          </p>
          <ul className="mt-2 space-y-1">
            {BANDS.map((b) => (
              <li key={b.band} className="flex items-baseline gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-indigo-50 text-xs font-bold text-indigo-700">
                  {b.band}
                </span>
                <p className="min-w-0 text-xs leading-5 text-slate-600">
                  <span className="font-medium text-slate-800">{b.label}</span> — {b.desc}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section className="card !p-4 min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">Raw score to band</h2>
          <p className="mt-0.5 text-xs leading-5 text-slate-600">
            Out of 40. This is the conversion BandUp marks with, so a practice band and an exam
            band are read off the same scale.
          </p>
          {/* Held to a readable measure rather than stretched across the card:
              three short columns spread over 700px put the reading figure a
              long way from the band it belongs to. */}
          <div className="mt-2 max-w-sm overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="text-left text-slate-500">
                  <th scope="col" className="w-12 py-1 pr-2 font-medium">Band</th>
                  <th scope="col" className="py-1 pr-2 font-medium">Listening</th>
                  <th scope="col" className="py-1 font-medium">Reading</th>
                </tr>
              </thead>
              <tbody>
                {bandBoundaries("listening")
                  .filter((row) => row.band >= 4)
                  .map((row) => {
                    const reading = bandBoundaries("reading").find((r) => r.band === row.band);
                    return (
                      <tr key={row.band} className="border-t border-slate-200/70">
                        <td className="py-1 pr-2 font-semibold text-slate-800 tabular-nums">
                          {row.band}
                        </td>
                        <td className="py-1 pr-2 text-slate-600 tabular-nums">
                          {row.from === row.to ? row.from : `${row.from}–${row.to}`}
                        </td>
                        <td className="py-1 text-slate-600 tabular-nums">
                          {reading
                            ? reading.from === reading.to
                              ? reading.from
                              : `${reading.from}–${reading.to}`
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </section>

          <section className="card !p-4 min-w-0">
            <h2 className="text-sm font-semibold text-slate-900">Question types you will meet</h2>
            <p className="mt-0.5 text-xs leading-5 text-slate-600">
              Every one of these appears in BandUp&rsquo;s papers, drawn the way the exam draws it.
            </p>
            <dl className="mt-2 space-y-1.5">
              {QUESTION_TYPES.map(([name, what]) => (
                <div key={name}>
                  <dt className="text-xs font-semibold text-slate-800">{name}</dt>
                  <dd className="text-xs leading-5 text-slate-600">{what}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="card !p-4 min-w-0">
            <h2 className="text-sm font-semibold text-slate-900">On the day</h2>
            <p className="mt-0.5 text-xs leading-5 text-slate-600">
              How the computer-delivered test actually runs.
            </p>
            <dl className="mt-2 space-y-1.5">
              {ON_THE_DAY.map(([name, what]) => (
                <div key={name}>
                  <dt className="text-xs font-semibold text-slate-800">{name}</dt>
                  <dd className="text-xs leading-5 text-slate-600">{what}</dd>
                </div>
              ))}
            </dl>
          </section>
      </div>
    </div>
  );
}
