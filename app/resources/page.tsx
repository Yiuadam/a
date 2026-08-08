import Link from "next/link";
import { Icon } from "@/components/Icons";

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

export default function ResourcesPage() {
  return (
    <div className="space-y-10">
      <div className="max-w-xl space-y-2">
        <h1 className="text-[26px] font-semibold text-slate-900">Exam guides</h1>
        <p className="text-[15px] leading-7 text-slate-600">
          What each part of the test actually asks of you, and the handful of habits that move
          your score the most.
        </p>
      </div>

      <section className="card">
        <h2 className="text-base font-semibold text-slate-900">What the band numbers mean</h2>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          You get a band from 1 to 9 for each skill, then an overall band — the average, rounded
          to the nearest half.
        </p>
        <ul className="mt-4 space-y-2">
          {BANDS.map((b) => (
            <li key={b.band} className="flex items-start gap-4">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-sm font-bold text-indigo-700">
                {b.band}
              </span>
              <div>
                <p className="text-sm font-medium text-slate-800">{b.label}</p>
                <p className="text-sm leading-6 text-slate-600">{b.desc}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {SECTIONS.map((s) => (
        <section key={s.title} className="card">
          <div className="flex items-baseline gap-3">
            <Icon name={s.icon} className="h-6 w-6 shrink-0 translate-y-1 text-indigo-600" />
            <div>
              <h2 className="text-base font-semibold text-slate-900">{s.title}</h2>
              <p className="text-xs text-slate-500">{s.time}</p>
            </div>
          </div>
          <ul className="mt-4 space-y-3">
            {s.tips.map((t, i) => (
              <li key={i} className="flex gap-3 text-[15px] leading-7 text-slate-700">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
                {t}
              </li>
            ))}
          </ul>
        </section>
      ))}

      <div className="card flex flex-col items-center gap-3 text-center">
        <p className="text-[15px] text-slate-700">Ready to put it into practice?</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Link href="/practice" className="btn-primary">
            Take a practice test
          </Link>
          <Link href="/speaking" className="btn-secondary">
            Try the speaking examiner
          </Link>
        </div>
      </div>
    </div>
  );
}
