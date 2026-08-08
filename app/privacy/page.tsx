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
    "What BandUp stores, what leaves your device, and what happens to your microphone. Accounts are optional, and there are no cookies or trackers.",
};

const LAST_UPDATED = "8 August 2026";

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
  {
    key: "bandup.speech.v1",
    what: "Which speech recogniser you chose for the speaking test, and which model size.",
  },
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
  {
    feature: "Ask a tutor",
    route: "/api/chat",
    what: "The question you typed, and the recent messages of that conversation so the answer follows on. The conversation lives in the tab you are reading it in and is gone when you close it.",
  },
];

export default function PrivacyPage() {
  return (
    <div className="space-y-10">
      <div className="max-w-xl space-y-2">
        <h1 className="text-[26px] font-semibold text-slate-900">Privacy</h1>
        <p className="text-[15px] leading-7 text-slate-600">
          Your practice stays in the browser or app on your device. An account is optional and
          changes only what is named below. This page says exactly what that means, and where
          the exceptions are.
        </p>
        <p className="text-xs text-slate-500">Last updated {LAST_UPDATED}</p>
      </div>

      <section className="card">
        <h2 className="heading-rule text-base font-semibold text-slate-900">The short version</h2>
        <ul className="mt-4 space-y-3">
          {[
            "An account is optional. Signed out — which is the default, and how the app ships today — nothing identifies you and nothing is held about you.",
            "Your progress is saved on your device only. It never reaches a server of ours.",
            "No cookies, no analytics, no advertising and no third-party trackers.",
            "Your writing and your speaking transcript are sent for marking when you ask for it, and are not stored afterwards.",
            "BandUp never uploads audio from your microphone and never saves it as a file.",
            "On the web you can choose to have your speech transcribed on your own device, so the audio never leaves it at all. The recogniser built into your browser or phone is still the default.",
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
          that device. These five entries are the whole of it:
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
          One further thing can be stored, and only if you ask for it: if you turn on on-device
          transcription in the speaking test, the speech model it needs (about 75 or 145 MB,
          depending on which you pick) is downloaded once and kept in your browser&rsquo;s cache
          so it works offline afterwards. It holds no data about you — it is the same file
          every user downloads — and the speaking test offers a button to delete it.
        </p>
        <p className="mt-3 text-sm leading-6 text-slate-600">
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
          One other request leaves your device, and it carries nothing of yours: if you turn on
          on-device transcription, the speech model is downloaded once from Hugging Face. It is
          described in full under the microphone below.
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
          part worth reading carefully, because the speaking test now offers two ways of turning
          speech into text and they differ in exactly this respect. You choose on the screen
          before the interview starts.
        </p>

        <h3 className="mt-6 text-sm font-semibold text-slate-900">
          Your device&rsquo;s recogniser — the default
        </h3>
        <ul className="mt-3 space-y-3">
          <li className="flex gap-3 text-[15px] leading-7 text-slate-700">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            Your speech is turned into text by the recogniser built into the device or browser
            you are using — Apple&rsquo;s speech recognition in the iOS app, the browser&rsquo;s
            own Web Speech API on the web. BandUp receives only the words it returns.
          </li>
          <li className="flex gap-3 text-[15px] leading-7 text-slate-700">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            Those recognisers are not ours, and some of them send audio to their own servers to
            transcribe it — Chrome&rsquo;s uploads to Google. Apple and the makers of Chrome,
            Safari and Edge each decide whether recognition happens on the device or in their
            cloud, and that is governed by their privacy policies, not this one. We would rather
            tell you this plainly than claim your voice never leaves the phone when we cannot
            guarantee it.
          </li>
        </ul>

        <h3 className="mt-6 text-sm font-semibold text-slate-900">
          On-device transcription — if you turn it on
        </h3>
        <ul className="mt-3 space-y-3">
          <li className="flex gap-3 text-[15px] leading-7 text-slate-700">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            With this on, your audio never leaves your device. A speech model called Whisper
            runs inside your own browser and does the transcription there. Nothing is sent to
            BandUp, to us, or to anyone else, and no recogniser outside your device hears it.
          </li>
          <li className="flex gap-3 text-[15px] leading-7 text-slate-700">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            Your answer is held in memory while you speak, because this model needs the whole
            answer before it can transcribe it. It is never written to a file and it is
            discarded as soon as the text comes back.
          </li>
          <li className="flex gap-3 text-[15px] leading-7 text-slate-700">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            There is one exception worth being exact about, and it is not audio. The model
            itself has to be downloaded before it can run, and it comes from Hugging Face, who
            host it. That request happens once, then the file is cached and used offline. Hugging
            Face therefore sees that some device asked for the file, along with the IP address
            any download reveals. It carries no audio, no transcript, no identifier, and nothing
            about you or your practice.
          </li>
          <li className="flex gap-3 text-[15px] leading-7 text-slate-700">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            This option is available on the web. The iOS app does not offer it yet: the
            on-device model there is written but not yet built into a released version, so in
            the app the speaking test still uses Apple&rsquo;s recogniser. When that changes,
            this page changes with it.
          </li>
        </ul>

        <p className="mt-6 text-[15px] leading-7 text-slate-700">
          Both ways share the rest: BandUp never uploads your audio and never saves it as a
          file. Only the finished transcript — text — is sent for marking, and only when you ask
          for feedback. The microphone is used during the speaking test and at no other time.
          You can also skip the microphone entirely and type your answers.
        </p>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          The speaking examiner also reads its questions aloud using the voice built into your
          device. That is playback only; nothing is captured.
        </p>
      </section>

      <section className="card">
        <h2 className="heading-rule text-base font-semibold text-slate-900">
          If you sign in
        </h2>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          BandUp can be used entirely signed out, and is by default. The placement test, your
          study plan, every practice test and both sets of drills work without an account and
          always will. An account exists to carry that work between your phone and your laptop,
          and to raise the daily limit on AI feedback.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          Signing in uses Google or Apple. BandUp never sees your password — the provider
          confirms it is you and passes on your email address and nothing else. There is no
          password here to lose or to leak, because there is none to set.
        </p>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">If you do sign in, we hold:</p>
        <ul className="mt-4 space-y-3">
          {[
            "Your email address, so the account can be recovered if you lose access to Google or Apple.",
            "A count of AI requests over the last 24 hours, so the daily allowance can be applied. It records that a request happened and to which feature — never what you wrote, said or were told.",
            "A copy of your study progress, if you choose to sync it, so a new device can pick up where the last one left off.",
            "Anything you choose to put on your account page: a display name, a profile picture, and optionally your date of birth. All of it is optional, all of it can be cleared, and the account works exactly the same if you leave it empty.",
          ].map((line) => (
            <li key={line} className="flex gap-3 text-[15px] leading-7 text-slate-700">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
              {line}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-[15px] leading-7 text-slate-700">
          <strong>Your date of birth is used for exactly one thing:</strong> confirming you are
          13 or over. This app is not intended for younger children, and a date of birth is the
          only way that can be checked rather than assumed. Nothing else reads it — it does not
          affect your plan, your band or anything you see.
        </p>
        <p className="mt-4 text-[15px] leading-7 text-slate-700">
          We previously asked for your gender. It has been removed, because nothing in BandUp
          ever used it and holding personal information with no purpose is not something we
          want to do. Any gender already stored has been deleted along with the field.
        </p>
        <p className="mt-4 text-[15px] leading-7 text-slate-700">
          Your profile picture is stored privately and is never public. BandUp has no profile
          pages, no leaderboards and no way for other learners to find you, so the only person
          who ever sees it is you. It is served through a link that expires after an hour
          rather than from a permanent address.
        </p>
        <p className="mt-4 text-[15px] leading-7 text-slate-700">
          Account data is stored with Supabase, who host the database on our behalf. Their
          servers may be in a different country from yours, which is true of almost any hosted
          service and is worth saying rather than leaving you to assume otherwise.
        </p>
        <p className="mt-4 text-[15px] leading-7 text-slate-700">
          Questions about any of this, or a request about your data, go to{" "}
          <a href="mailto:hello@bandup.study" className="underline underline-offset-2 hover:text-slate-900">
            hello@bandup.study
          </a>
          .
        </p>
        <p className="mt-4 text-[15px] leading-7 text-slate-700">
          Signing out ends the session on that device and deletes nothing. To close the account
          altogether, use <strong>Delete your account</strong> on your account page: it removes
          your email address, your details, your picture and any synced practice, immediately
          and permanently. The copy in your own browser stays, because it was never ours to
          delete — clear that from your browser&rsquo;s settings whenever you like.
        </p>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Sessions are kept in your device&rsquo;s own storage rather than in a cookie, which is
          why signing in still sets none.
        </p>
      </section>

      <section className="card">
        <h2 className="heading-rule text-base font-semibold text-slate-900">
          Cookies and tracking
        </h2>
        <p className="mt-3 text-[15px] leading-7 text-slate-700">
          There are none. BandUp sets no cookies, includes no analytics or advertising scripts,
          and loads nothing from a third party that could watch you across sites. There is no
          consent banner here because there is nothing to consent to. Signing in does not change
          this: the session is held in your device&rsquo;s own storage, not in a cookie.
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
          Signed out there is no request to send us and no account to close, because nothing is
          held on our side to delete. That deletion is final — your progress cannot be restored
          afterwards. If you have an account, see below for what it holds and how to close it.
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
