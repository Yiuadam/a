import Link from "next/link";
import { Icon } from "@/components/Icons";
import { rawToBand } from "@/lib/band";

const SECTIONS = [
  {
    icon: "listening",
    title: "Listening",
    time: "30 minutes · 40 questions · 4 sections",
    tips: [
      "You hear the recording once. Read the questions during the pause before each section so you know what to listen for.",
      "Answers come in order. If you miss one, let it go and catch the next — chasing it costs you two more.",
      "Spelling and grammar count. \"childrens\" or a missing plural s marks the answer wrong even if you heard it correctly.",
      "Watch for corrections: speakers say \"Tuesday — sorry, Thursday\". The second one is the answer.",
      "Respect the word limit. \"No more than two words\" means three words scores zero.",
    ],
  },
  {
    icon: "reading",
    title: "Reading",
    time: "60 minutes · 40 questions · 3 passages",
    tips: [
      "Don't read the whole passage first. Read the questions, then scan for the answer.",
      "Budget 20 minutes per passage. If you're stuck, guess and move on — every question is worth the same.",
      "True/False/Not Given: FALSE means the passage says the opposite. NOT GIVEN means the passage simply doesn't mention it. When in doubt between them, ask \"does the text contradict this, or just stay silent?\"",
      "Answers are paraphrased, not copied. Look for the idea, not the exact words.",
      "For completion questions, copy the word exactly as it appears in the passage.",
    ],
  },
  {
    icon: "writing",
    title: "Writing",
    time: "60 minutes · Task 1 (20 min) + Task 2 (40 min)",
    tips: [
      "Task 2 is worth twice as much as Task 1. Do Task 1 first but never let it eat into your 40 minutes.",
      "Task 1 needs an overview paragraph — the single biggest trend or difference. Missing it caps your Task Achievement score.",
      "Never give an opinion in Academic Task 1. Report what the data shows, nothing more.",
      "In Task 2, answer every part of the question. \"Discuss both views and give your opinion\" is three jobs, not one.",
      "Under length is an automatic penalty. Aim for 170 and 270 words rather than the bare 150 and 250.",
      "Spend the last 3 minutes checking articles, plurals and verb tenses — the errors that cost the most marks.",
    ],
  },
  {
    icon: "speaking",
    title: "Speaking",
    time: "11–14 minutes · 3 parts, face to face",
    tips: [
      "Part 1 answers should be two or three sentences. One word is too short; a speech is too long.",
      "In Part 2 use the full two minutes. Use the preparation minute to note keywords, not sentences.",
      "It's fine to invent details. You're scored on your English, not on whether the story is true.",
      "Part 3 wants opinions and reasons: state a view, explain why, give an example, consider the other side.",
      "If you don't know a word, paraphrase around it. Paraphrasing scores; silence doesn't.",
      "Fluency beats perfection. Keep going rather than restarting sentences to fix small errors.",
    ],
  },
];

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
        Four guides and the band scale on one screen. Each guide opens where it
        stands rather than sending the reader down a page of prose: the tips are
        all still here, in the same words, one tap away and never more than one
        section at a time. Nothing is summarised away — <summary> carries the
        module, the timing and how many tips are inside.
      */}
      <div className="grid gap-3 lg:grid-cols-3">
        <section className="card !p-4 order-2 h-fit min-w-0 lg:order-1">
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

        <section className="card !p-4 order-3 h-fit min-w-0 lg:order-3">
          <h2 className="text-sm font-semibold text-slate-900">Raw score to band</h2>
          <p className="mt-0.5 text-xs leading-5 text-slate-600">
            Out of 40. This is the conversion BandUp marks with, so a practice band and an exam
            band are read off the same scale.
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="text-left text-slate-500">
                  <th scope="col" className="py-1 pr-2 font-medium">Band</th>
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

        <div className="order-1 grid min-w-0 gap-3 sm:grid-cols-2 lg:order-2 lg:col-span-2 2xl:grid-cols-3 lg:content-start">
          {/*
            Open by default: this is a reference page, and four closed drawers
            make somebody click four times to read what they came for. They
            still close, for anyone who wants the list back.
          */}
          {SECTIONS.map((s) => (
            <details key={s.title} open className="card !p-4 group h-fit min-w-0">
              <summary className="flex cursor-pointer list-none items-center gap-2.5 [&::-webkit-details-marker]:hidden">
                <Icon name={s.icon} className="h-5 w-5 shrink-0 text-indigo-600" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-slate-900">{s.title}</span>
                  <span className="block text-xs text-slate-500">
                    {s.time} · {s.tips.length} tips
                  </span>
                </span>
                {/* The affordance: closed points right, open points down. */}
                <span
                  aria-hidden
                  className="shrink-0 text-slate-400 transition-transform group-open:rotate-90"
                >
                  ›
                </span>
              </summary>
              <ul className="mt-3 space-y-2">
                {s.tips.map((t, i) => (
                  <li key={i} className="flex gap-2 text-sm leading-6 text-slate-700">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
                    {t}
                  </li>
                ))}
              </ul>
            </details>
          ))}

          <section className="card !p-4 h-fit min-w-0">
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

          <section className="card !p-4 h-fit min-w-0">
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
    </div>
  );
}
