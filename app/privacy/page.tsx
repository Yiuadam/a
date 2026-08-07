import type { Metadata } from "next";
import Link from "next/link";

/*
  A server component, unlike almost every other page here, because
  `export const metadata` is only legal in one — and this page has a job outside
  the app: Apple requires a reachable privacy-policy URL for submission, and
  reads it particularly closely for an app that asks for the microphone.

  Everything below is a claim about what the code does. Each one is checked
  against the code rather than written from intention, because an inaccurate
  privacy policy is worse for a learner than no policy at all. Anything that
  changes what leaves the device — a new route under app/api, a new
  localStorage key, an analytics script — has to change this page too.
*/

export const metadata: Metadata = {
  title: "Privacy — BandUp",
  description:
    "What BandUp stores, what leaves your device, and what happens to your microphone. No account, no cookies, no trackers.",
};

const LAST_UPDATED = "7 August 2026";

/* The four keys are the whole of what BandUp writes — see lib/store.ts,
   lib/drills.ts, lib/lookups.ts and lib/theme.ts. */
const STORED = [
  {
    key: "ielts-prep-v1",
    what: "Your placement result, target band, study plan and test scores.",
  },
  {
    key: "bandup.drills.v1",
    what: "Which grammar and vocabulary drills you have finished, and how you did.",
  },
  {
    key: "bandup.lookups.v1",
    what: "Words you have tapped to look up, so you can revise them later.",
  },
  { key: "bandup.theme", what: "Whether you chose the warm, light or dark theme." },
];

/* Every network call that carries your text. There are no others. */
const SENT = [
  {
    feature: "Writing marking",
    route: "/api/grade/writing",
    what: "The essay you wrote and the task prompt it answers.",
  },
  {
    feature: "Speaking marking",
    route: "/api/grade/speaking",
    what: "The written transcript of your interview — the text, never the audio.",
  },
  {
    feature: "New practice tests",
    route: "/api/generate",
    what: "The topic and difficulty you picked. Nothing about you.",
  },
  {
    feature: "Word lookup",
    route: "/api/define",
    what: "The word you selected and the sentence it appeared in.",
  },
];

export default function PrivacyPage() {
  return (
    <div className="space-y-10">
      <div className="max-w-xl space-y-2">
        <h1 className="text-[26px] font-semibold text-slate-900">Privacy</h1>
        <p className="text-[15px] leading-7 text-slate-600">
          BandUp has no accounts and no user database. Your practice stays in the browser or
          app on your device. This page says exactly what that means, and where the exceptions
          are.
        </p>
        <p className="text-xs text-slate-500">Last updated {LAST_UPDATED}</p>
      </div>

      <section className="card">
        <h2 className="heading-rule text-base font-semibold text-slate-900">The short version</h2>
        <ul className="mt-4 space-y-3">
          {[
            "There is no account to create, so there is nothing to sign up with and no profile held about you.",
            "Your progress is saved on your device only. It never reaches a server of ours.",
            "No cookies, no analytics, no advertising and no third-party trackers.",
            "Your writing and your speaking transcript are sent for marking when you ask for it, and are not stored afterwards.",
            "BandUp never records, uploads or stores audio from your microphone.",
          ].map((line) => (
            <li key={line} className="flex gap-3 text-[15px] leading-7 text-slate-700">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
              {line}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2 className="heading-rule text-base font-semibold text-slate-900">
          What is stored, and where
        </h2>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          Everything BandUp remembers about you is written to your browser&rsquo;s local storage
          — inside the app on iOS, in the browser on the web. It is readable only by BandUp on
          that device. These four entries are the whole of it:
        </p>
        <ul className="mt-4 space-y-3">
          {STORED.map((s) => (
            <li key={s.key}>
              <p className="font-mono text-xs text-indigo-700">{s.key}</p>
              <p className="text-[15px] leading-7 text-slate-700">{s.what}</p>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          Because this lives on the device and nowhere else, your progress does not follow you
          to a new phone or a different browser, and we cannot recover it for you if it is
          lost.
        </p>
      </section>

      <section className="card">
        <h2 className="heading-rule text-base font-semibold text-slate-900">
          What leaves your device
        </h2>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          Four features need a model to think about your English, and those are the only times
          anything you write is sent anywhere. Each one goes to BandUp&rsquo;s server, which
          passes it to Anthropic&rsquo;s API for the answer and sends that answer back to you.
          BandUp writes none of it to a database or a log.
        </p>
        <ul className="mt-4 space-y-4">
          {SENT.map((s) => (
            <li key={s.route}>
              <p className="text-sm font-medium text-slate-800">
                {s.feature}{" "}
                <span className="font-mono text-xs font-normal text-slate-500">{s.route}</span>
              </p>
              <p className="text-[15px] leading-7 text-slate-700">{s.what}</p>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          Your placement result, your study plan and your test scores are never among them.
          Anthropic handles what it receives under its own terms; BandUp sends no name, no
          email and no identifier alongside it, because it holds none.
        </p>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Placement, the study plan, the bundled practice tests, the grammar and vocabulary
          drills and the marking of reading and listening answers all run entirely on your
          device, and work with no connection at all.
        </p>
      </section>

      <section className="card">
        <h2 className="heading-rule text-base font-semibold text-slate-900">
          The microphone, in full
        </h2>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          The speaking test asks for microphone access so it can hear your answers. This is the
          part worth reading carefully.
        </p>
        <ul className="mt-4 space-y-3">
          <li className="flex gap-3 text-[15px] leading-7 text-slate-700">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            BandUp does not record your voice, does not save an audio file, and does not upload
            audio anywhere. There is no recording to keep.
          </li>
          <li className="flex gap-3 text-[15px] leading-7 text-slate-700">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            Your speech is turned into text by the speech recogniser built into the device or
            browser you are using — Apple&rsquo;s speech recognition in the iOS app, the
            browser&rsquo;s own Web Speech API on the web. BandUp receives only the words it
            returns.
          </li>
          <li className="flex gap-3 text-[15px] leading-7 text-slate-700">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            Those recognisers are not ours, and some of them send audio to their own servers to
            transcribe it. Apple and the makers of Chrome, Safari and Edge each decide whether
            recognition happens on the device or in their cloud, and that is governed by their
            privacy policies, not this one. We would rather tell you this plainly than claim
            your voice never leaves the phone when we cannot guarantee it.
          </li>
          <li className="flex gap-3 text-[15px] leading-7 text-slate-700">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            Only the finished transcript — text — is sent for marking, and only when you ask
            for feedback. The microphone is used during the speaking test and at no other time.
          </li>
        </ul>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          The speaking examiner also reads its questions aloud using the voice built into your
          device. That is playback only; nothing is captured.
        </p>
      </section>

      <section className="card">
        <h2 className="heading-rule text-base font-semibold text-slate-900">
          Cookies and tracking
        </h2>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          There are none. BandUp sets no cookies, includes no analytics or advertising scripts,
          and loads nothing from a third party that could watch you across sites. There is no
          consent banner here because there is nothing to consent to.
        </p>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          The web version is served by a hosting provider that, like any web host, records
          ordinary server request logs. BandUp does not use those logs to build any picture of
          you.
        </p>
      </section>

      <section className="card">
        <h2 className="heading-rule text-base font-semibold text-slate-900">
          Deleting your data
        </h2>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          Everything is on your device, so deleting it is entirely in your hands and takes
          effect immediately:
        </p>
        <ul className="mt-4 space-y-3">
          <li className="flex gap-3 text-[15px] leading-7 text-slate-700">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            In the app: delete BandUp from your device. Its storage goes with it.
          </li>
          <li className="flex gap-3 text-[15px] leading-7 text-slate-700">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            On the web: clear site data for this site in your browser&rsquo;s settings.
          </li>
        </ul>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          There is no request to send us and no account to close, because there is nothing held
          on our side to delete. That deletion is final — your progress cannot be restored
          afterwards.
        </p>
      </section>

      <section className="card">
        <h2 className="heading-rule text-base font-semibold text-slate-900">Children</h2>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          BandUp is a study tool for people preparing for an English exam and is not aimed at
          children under 13. It collects nothing that would identify anyone of any age.
        </p>
      </section>

      <section className="card">
        <h2 className="heading-rule text-base font-semibold text-slate-900">
          Changes to this policy
        </h2>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          If what BandUp stores or sends ever changes, this page changes with it and the date
          at the top is updated. The version you are reading ships inside the app you have
          installed, so it always describes that version.
        </p>
      </section>

      <div className="card flex flex-col items-center gap-3 text-center">
        <p className="text-[15px] text-slate-700">
          That is the whole policy. Back to the practice:
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Link href="/" className="btn-primary">
            Go to the dashboard
          </Link>
          <Link href="/resources" className="btn-secondary">
            Read the exam guides
          </Link>
        </div>
      </div>
    </div>
  );
}
