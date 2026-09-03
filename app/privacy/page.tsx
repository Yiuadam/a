import type { Metadata } from "next";
import Link from "next/link";
import { ADMIN_OVERVIEW_STORAGE_KEY } from "@/lib/admin/overview";

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
    "What BandUp stores, what leaves your device, and what happens to your microphone. Accounts are optional, there are no cookies or trackers, and card details never reach our servers.",
};

const LAST_UPDATED = "4 September 2026";

/*
  The learner keys plus the owner's one local dashboard preference.

  The list used to omit the in-progress mock exam, and the paragraph above it
  used to call the whole set "the five learner entries", all of which were said
  to sync. Neither was true. Three sync — see PROGRESS_KEYS in
  lib/progress/storage.ts — the theme and speech choices never leave the
  browser, and the half-finished exam holds a learner's own essay text while
  never being uploaded at all. An omission on this page is the same kind of
  mistake as a false sentence, so the exam is listed here with the rest.

  The autosaved practice essay (lib/writing-draft.ts) is here for the same
  reason and is the plainest case of it: the list is introduced with "This is
  the whole of it", and a key holding a learner's own unfinished prose is the
  last one that may be missing from a list making that claim.
*/
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
  {
    key: "bandup-mock-exam-v1",
    what: "A mock exam you have started but not finished, including anything you have written in it so far. It is held here until you finish, and it is never sent to your account.",
  },
  {
    key: "bandup.writing-draft.v1",
    what: "A practice essay you are part-way through, saved as you type so that a reload or a phone locking cannot take it. It stays in the tab you are writing in, it is never sent to your account, and it is thrown away when you submit it, when you leave the writing paper, or twelve hours after you last typed.",
  },
  {
    key: ADMIN_OVERVIEW_STORAGE_KEY,
    what: "For a site administrator only: which two charts they chose for the admin overview. It contains no learner, account or financial data and stays in that browser.",
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
    what: "The question you typed, the recent messages of that conversation so the answer follows on, and \u2014 when you have finished marked speaking interviews \u2014 extracts from them: the text of your own answers and the examiner\u2019s questions, never the audio. The conversation itself lives in the tab you are reading it in and is gone when you close it.",
  },
];

export default function PrivacyPage() {
  return (
    /*
      Capped at 3xl even though the shell is now much wider. A legal page is
      prose end to end, and prose has an optimum measure of roughly 60-90
      characters — past that the eye loses the start of the next line on the
      way back. When the shell went 1024px -> 1536px these paragraphs went with
      it, to 1446px, about 220 characters a line. Wide shells are for grids;
      text keeps its own ceiling.
    */
    <div className="mx-auto max-w-3xl space-y-10">
      <div className="max-w-xl space-y-2">
        <h1 className="text-[1.625rem] font-semibold text-slate-900">Privacy</h1>
        <p className="text-[0.9375rem] leading-7 text-slate-600">
          Without an account, your practice stays on your device and is gone when you close the
          browser. With one, it is synced so a second device can pick it up. An account is
          optional and changes only what is named below. This page says exactly what that means,
          and where the exceptions are.
        </p>
        <p className="text-xs text-slate-500">Last updated {LAST_UPDATED}</p>
      </div>

      <section className="card">
        <h2 className="heading-rule text-base font-semibold text-slate-900">The short version</h2>
        <ul className="mt-4 space-y-3">
          {[
            "An account is optional. Signed out — which is the default, and how the app ships today — nothing identifies you and nothing is held about you.",
            "Signed out, your progress lives only in the tab you have open and is gone when you close it. Signed in, it is kept on your account so it follows you between devices.",
            "No cookies, no analytics, no advertising and no third-party trackers.",
            "Your writing and speaking transcript are sent for marking when you ask. Signed out, they disappear with the tab; signed in, completed feedback can be stored in your private history so you can revisit it.",
            "BandUp keeps technical AI-cost records — the feature, model, token counts, calculated cost, request ID and time — but never the words sent or received, your name, email or account ID.",
            "The tutor reads your saved speaking practice. Ask it anything and extracts from your own mock interviews go with the question, so its advice is about how you actually speak rather than about the exam in general. This is not something you switch on \u2014 and if you have never finished a marked speaking interview, nothing about your speaking is sent.",
            "BandUp never uploads audio from your microphone and never saves it as a file.",
            "On the web you can choose to have your speech transcribed on your own device, so the audio never leaves it at all. The recogniser built into your browser or phone is still the default.",
          ].map((line) => (
            <li key={line} className="flex gap-3 text-[0.9375rem] leading-7 text-slate-700">
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
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          Signed out, everything BandUp remembers about you lives in the browser you are using
          and nowhere else. Your practice is held in the tab: close it and that work is gone, and
          you start fresh. Your theme and speech choices are settings rather than work, so they
          stay in that browser until you clear it. Signed in, three of the entries below — your
          progress, your drills and your saved words — are kept on your account as well, so they
          follow you between devices; the rest never leave this browser, including an exam you
          have started and not finished and an essay you are part-way through. The last
          entry is only an admin dashboard layout and
          always stays in that administrator&rsquo;s browser. This is the whole of it:
        </p>
        <ul className="mt-4 space-y-3">
          {STORED.map((s) => (
            <li key={s.key}>
              <p className="font-mono text-xs text-indigo-700">{s.key}</p>
              <p className="text-[0.9375rem] leading-7 text-slate-700">{s.what}</p>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          Two standard model files can also be stored on your device. If you turn on on-device
          transcription in the speaking test, its speech model (about 75 or 145 MB, depending
          on which you pick) is downloaded once and kept in your browser&rsquo;s cache. On the web
          there is also a 92 MB voice model, but only as a last resort: the examiner&rsquo;s
          questions play as ordinary recordings, so starting an interview downloads nothing. That
          model arrives only if your browser turns out to have no English voice of its own — when
          you tap to hear a looked-up word said aloud, or when a listening paper cannot be read to
          you any other way. Both run on your device, hold no data about you and are the same
          files every learner downloads.
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
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          Five features need a model to think about your English, and those are the only times
          anything you write is sent anywhere. Each one goes to BandUp&rsquo;s server, which
          passes it to Anthropic&rsquo;s API for the answer and sends that answer back to you.
          The marking request itself is not written to a server log. If you are signed in and
          save your completed practice, its feedback record can include the essay or speaking
          transcript so your history can be reopened later.
        </p>
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          One of those five sends more than what you have just typed. When you ask the tutor a
          question, extracts from your own mock speaking interviews go with it, because
          otherwise its advice can only be about IELTS in general. What travels is the text of
          your own answers and the examiner&rsquo;s questions from two of your interviews &mdash;
          chosen automatically as the weakest of your recent ones, because that is where there
          is something useful to say &mdash; together with the date and band of your other
          recent speaking results. It is bounded rather than complete: a long interview is
          trimmed to fit, and the tutor is told when it is only seeing part of one. This happens
          on every question you ask it and is not something you turn on. If you have never
          finished a marked speaking interview there is nothing to send and nothing is sent, and
          clearing your history removes the saved interviews, after which the tutor has nothing
          of your speaking to read.
        </p>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          To measure what the AI actually costs, BandUp keeps a separate technical receipt for
          each completed request: the feature used, Claude model, provider request ID, input,
          output and cache token counts, calculated cost and time. It contains no prompt,
          answer, transcript, name, email or account ID and cannot recreate what anybody wrote
          or said.
        </p>
        <ul className="mt-4 space-y-4">
          {SENT.map((s) => (
            <li key={s.route}>
              <p className="text-sm font-medium text-slate-800">
                {s.feature}{" "}
                <span className="font-mono text-xs font-normal text-slate-500">{s.route}</span>
              </p>
              <p className="text-[0.9375rem] leading-7 text-slate-700">{s.what}</p>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          Your placement result, your study plan and your test scores are never among them.
          Anthropic handles what it receives under its own terms; BandUp sends no name, no
          email and no identifier alongside it, because it holds none.
        </p>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Model downloads also leave your device, and carry none of your work. If you turn on
          on-device transcription, its speech model is downloaded once from Hugging Face, who
          host it — or, if your school, network or country blocks that host, from BandUp&rsquo;s
          own server, which fetches the same file for you. The examiner&rsquo;s voice model is
          worth being exact about, because it works
          the other way round: your browser never asks Hugging Face for it. It asks
          BandUp&rsquo;s own server, at <span className="font-mono text-xs">/api/kokoro-model</span>,
          and that server fetches the file from Hugging Face on your behalf — so for this one
          Hugging Face sees us and never you. The British voice itself already ships inside the
          app and is not downloaded from anywhere at all. And none of it is fetched unless your
          browser has no English voice of its own; starting an interview downloads nothing.
        </p>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          The examiner&rsquo;s questions are recordings rather than something your device speaks.
          Each is fetched as it is asked, from{" "}
          <span className="font-mono text-xs">/api/examiner-audio</span>, which receives a
          question number and nothing about you. They were made once, from the fixed questions
          written into this app, by a Deepgram voice running on Cloudflare — nothing you write or
          say has ever been sent there. If a recording will not play, your own device&rsquo;s
          voice reads the question instead.
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
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          The speaking test asks for microphone access so it can hear your answers. This is the
          part worth reading carefully, because the speaking test now offers two ways of turning
          speech into text and they differ in exactly this respect. You choose on the screen
          before the interview starts.
        </p>

        <h3 className="mt-6 text-sm font-semibold text-slate-900">
          Your device&rsquo;s recogniser — the default
        </h3>
        <ul className="mt-3 space-y-3">
          <li className="flex gap-3 text-[0.9375rem] leading-7 text-slate-700">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            Your speech is turned into text by the recogniser built into the device or browser
            you are using — Apple&rsquo;s speech recognition in the iOS app, the browser&rsquo;s
            own Web Speech API on the web. BandUp receives only the words it returns.
          </li>
          <li className="flex gap-3 text-[0.9375rem] leading-7 text-slate-700">
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
          <li className="flex gap-3 text-[0.9375rem] leading-7 text-slate-700">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            With this on, your audio never leaves your device. A speech model called Whisper
            runs inside your own browser and does the transcription there. Nothing is sent to
            BandUp, to us, or to anyone else, and no recogniser outside your device hears it.
          </li>
          <li className="flex gap-3 text-[0.9375rem] leading-7 text-slate-700">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            Your answer is held in memory while you speak, because this model needs the whole
            answer before it can transcribe it. It is never written to a file and it is
            discarded as soon as the text comes back.
          </li>
          <li className="flex gap-3 text-[0.9375rem] leading-7 text-slate-700">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            There is one exception worth being exact about, and it is not audio. The model
            itself has to be downloaded before it can run, and it comes from Hugging Face, who
            host it. That request happens once, then the file is cached and used offline. Hugging
            Face therefore sees that some device asked for the file, along with the IP address
            any download reveals. It carries no audio, no transcript, no identifier, and nothing
            about you or your practice. If that host is blocked where you are, your browser asks
            BandUp&rsquo;s server for the same file instead, and then it is we who ask Hugging
            Face rather than you.
          </li>
          <li className="flex gap-3 text-[0.9375rem] leading-7 text-slate-700">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            This option is available on the web. The iOS app does not offer it yet: the
            on-device model there is written but not yet built into a released version, so in
            the app the speaking test still uses Apple&rsquo;s recogniser. When that changes,
            this page changes with it.
          </li>
        </ul>

        <p className="mt-6 text-[0.9375rem] leading-7 text-slate-700">
          Both ways share the rest: BandUp never uploads your audio and never saves it as a
          file. Only the finished transcript — text — is sent for marking, and only when you ask
          for feedback. The microphone is used during the speaking test and at no other time.
          You can also skip the microphone entirely and type your answers.
        </p>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          The speaking examiner also reads its questions aloud. They are recordings made in
          advance, and the voice built into your device reads a question only if its recording
          will not play. Either way that is playback; nothing is captured.
        </p>
      </section>

      <section className="card">
        <h2 className="heading-rule text-base font-semibold text-slate-900">
          If you sign in
        </h2>
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          BandUp can be used entirely signed out, and is by default. The placement test, your
          study plan and both sets of drills work without an account and always will, and so do
          practice papers, with a weekly limit until you pay. An account exists to carry that
          work between your phone and your laptop. AI feedback needs a Plus or Pro plan: a free
          account has none of it, and neither does a signed-out visitor.
        </p>
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          You can sign in with Google, or with an email address and a password &mdash; on the
          website and in the iOS app alike. (Sign in with Apple is built but not switched on;
          when it is, this page will say so before it appears.) With
          Google, BandUp never sees a password at all: Google confirms it is you,
          and passes on your email address together with a permanent identifier for you that is
          unique to this app. That identifier, rather than your address, is what your account is
          filed under — which is why changing your email never loses you the account, and why
          knowing your address alone gets nobody into it. If you set a password instead, it is
          held by Supabase, our database provider, as a one-way hash: a value that can check a
          password is right and cannot be turned back into it. Nobody here can read your password,
          including us.
        </p>
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          Apple passes on one thing more, and only once. The very first time you use Sign in with
          Apple, Apple sends the first and last name on your Apple ID, and never sends it again —
          not on the next sign-in, and not if we ask. BandUp writes it into your display name if
          you do not already have one, and leaves an existing one alone. You can change it
          afterwards on your account page, and it is worth knowing what a display name is before
          you do: it is one of the two things an organisation owner, manager or teacher is shown
          when they look you up by your exact username. If you decline to give Apple&rsquo;s
          sheet your name, nothing is stored and nothing else about the sign-in changes.
        </p>
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">If you do sign in, we hold:</p>
        <ul className="mt-4 space-y-3">
          {[
            "Your email address, so the account can be recovered if you lose access to Google or Apple.",
            "A count of AI requests over the last thirty days, so each feature's allowance can be applied. It records that a request happened and to which feature — never what you wrote, said or were told.",
            "A one-way hash of the internet address the request came from, so that one address cannot spend an unlimited amount of AI by making accounts. It is salted and cannot be turned back into an address, and it is used for nothing else — not location, not advertising, not analytics.",
            "A copy of your completed study progress when you use an account, so your other devices can pick up where you left off.",
            "For completed writing and speaking practice, the saved history can include your essay or transcript and the feedback, so you can revisit the original sitting.",
            "Your unique username. Unless you change it, it is taken from the part of your email address before the @, and you can also ask BandUp for a random suggestion instead. A username is public — it appears in an organisation's team directory and works as a sign-in name — so type over the suggestion if you would rather not publish part of your address. A display name can be added later. A profile picture and date of birth remain optional.",
          ].map((line) => (
            <li key={line} className="flex gap-3 text-[0.9375rem] leading-7 text-slate-700">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
              {line}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-[0.9375rem] leading-7 text-slate-700">
          <strong>Your date of birth is used for exactly one thing:</strong> confirming you are
          13 or over. This app is not intended for younger children, and a date of birth is the
          only way that can be checked rather than assumed. Nothing else reads it — it does not
          affect your plan, your band or anything you see.
        </p>
        <p className="mt-4 text-[0.9375rem] leading-7 text-slate-700">
          We previously asked for your gender. It has been removed, because nothing in BandUp
          ever used it and holding personal information with no purpose is not something we
          want to do. Any gender already stored has been deleted along with the field.
        </p>
        <p className="mt-4 text-[0.9375rem] leading-7 text-slate-700">
          Your profile picture is stored privately and is never public. The only person who
          ever sees it is you: no teacher, manager or organisation is ever shown it. There are
          no profile pages and no leaderboards. It is served through a link that expires after
          an hour rather than from a permanent address.
        </p>
        <p className="mt-4 text-[0.9375rem] leading-7 text-slate-700">
          There is one way another person can find you, and it is worth being exact about.
          Somebody who owns, manages or teaches in an organisation can look you up by typing
          your exact username, which is how an invitation reaches the right account. They are
          shown your username and display name and nothing else. Your username cannot be
          browsed, listed or searched for by anybody in any other way, and a partial match
          finds nothing.
        </p>
        <p className="mt-4 text-[0.9375rem] leading-7 text-slate-700">
          Authentication and the core account record are stored with Supabase, and a copy of
          your account, profile, synced practice and usage counts is mirrored to Cloudflare D1.
          Your profile picture is kept as a private file in Cloudflare R2, and so is any synced
          practice too large to store alongside the record itself — which for a learner with
          many essays and speaking transcripts is most of it. Organisation workspaces and their
          private notification inboxes are stored there too. These providers host the service on
          our behalf and their servers may be in a different country from yours, which is worth
          saying rather than leaving you to assume otherwise.
        </p>
        <p className="mt-4 text-[0.9375rem] leading-7 text-slate-700">
          Questions about any of this, or a request about your data, go to{" "}
          <a href="mailto:hello@bandup.life" className="underline underline-offset-2 hover:text-slate-900">
            hello@bandup.life
          </a>
          .
        </p>
        <p className="mt-4 text-[0.9375rem] leading-7 text-slate-700">
          Signing out ends the session on that device and clears the copy kept there. Nothing is
          deleted from your account — sign back in and your synced progress comes back — but
          anything that was never synced does not, including an exam you had started and not
          finished.
        </p>
        <p className="mt-4 text-[0.9375rem] leading-7 text-slate-700">
          To close the account altogether, use <strong>Delete your account</strong> on your
          account page. Your sign-in is removed straight away — including the permanent
          identifier Google or Apple gave us for you, so that signing in with the same one
          afterwards opens a new, empty account rather than finding any trace of the old one —
          and the stored copies, your email address, your details, your picture and any synced
          practice, are erased within minutes of it, in both Supabase and Cloudflare. It cannot
          be undone.
        </p>
        <p className="mt-4 text-[0.9375rem] leading-7 text-slate-700">
          The copy in your own browser is separate, and you do not have to go into browser
          settings to be rid of it. Use <strong>Clear this device</strong> on your account page:
          it empties this browser and, while you are signed in, the synced copy of the work as
          well — your sittings, your placement result, your drill scores and your saved words —
          so none of it comes back from another device. Your account, your sign-in and your
          profile are untouched.
        </p>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Sessions are kept in your device&rsquo;s own storage rather than in a cookie, which is
          why signing in still sets none.
        </p>
      </section>

      <section className="card">
        <h2 className="heading-rule text-base font-semibold text-slate-900">
          Organisations, teachers and shared progress
        </h2>
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          If you join a school or other organisation in BandUp, that workspace stores your
          membership, role, teacher assignment and requests to join, leave or change access.
          Work completed after joining is shared with that organisation. Sharing work from
          before joining is a separate choice and, while you remain a student member, changing
          it uses an approval request.
        </p>
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          Owners, managers and any teacher you are assigned to can see your email address next to
          your name. A manager can also change your role, suspend you or remove you from the
          organisation without a request from you.
        </p>
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          Assigned teachers can see only their assigned students. Organisation managers can see
          members and student history in their own organisation. That history can include scores,
          answers, feedback, essays and speaking transcripts. BandUp administrators can access
          organisation records when needed to secure or support the service. Other
          learners cannot see them. Anyone signed in can create an organisation and becomes its
          owner at once, so an organisation is not something BandUp has checked.
        </p>
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          Your private notification inbox records typed events such as an assigned task, new
          teacher feedback, a completed assignment, an invitation or a membership request. Each
          item stores the organisation and event reference, who caused it when relevant, its time
          and whether you have read it. It does not copy the teacher&rsquo;s feedback text, an essay,
          a speaking transcript or an email address. The app only returns inbox items to their
          recipient. Closing your account deletes notifications received by you; if you caused an
          item kept in somebody else&rsquo;s inbox, your identity is removed from that item.
        </p>
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          An active, suspended or leaving student member cannot clear their history. Teachers may
          archive an assigned student&rsquo;s organisation view; managers may permanently remove an
          attempt from that organisation only, with a recorded reason. Neither action deletes the
          learner&rsquo;s original account record. Joining, decisions, assignments and removals create
          an audit record so permissions and data changes can be investigated.
        </p>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          After an approved departure, the former student can change the choice about earlier
          history without organisation approval. The choice about work completed during
          membership cannot be changed once the membership has ended, because there is no longer
          an active membership to change it on. Closing the BandUp account deletes the learner-owned source records; minimal
          security audit and organisation-removal records can remain where required to establish
          what an administrator did, without keeping the essay or transcript in those records.
        </p>
      </section>

      <section className="card">
        <h2 className="heading-rule text-base font-semibold text-slate-900">
          Cookies and tracking
        </h2>
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          There are none. BandUp sets no cookies, includes no analytics or advertising scripts,
          and loads nothing from a third party that could watch you across sites. There is no
          consent banner here because there is nothing to consent to. Signing in does not change
          this: the session is held in your device&rsquo;s own storage, not in a cookie.
        </p>
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          One honest edge: if you subscribe, the payment page is Stripe&rsquo;s own, on
          Stripe&rsquo;s domain, and it sets its own cookies under its own policy — as any
          payment page does. You are on their site for those two minutes, and back here after.
        </p>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          The web version is served by a hosting provider that, like any web host, records
          ordinary server request logs. BandUp does not use those logs to build any picture of
          you.
        </p>
      </section>

      {/*
        Payments.

        Stripe is a processor of a subscriber's personal data, so it has to be
        named here — GDPR Article 13 requires the recipients of personal data
        to be disclosed, not merely the fact that some exist. What matters most
        to a reader is the thing this section leads with: card numbers never
        arrive here at all, so there is no story where BandUp leaks one.
      */}
      <section className="card">
        <h2 className="heading-rule text-base font-semibold text-slate-900">
          If you subscribe
        </h2>
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          <strong>Your card details never reach BandUp.</strong> Paying takes you to Stripe, the
          payment company, and the card is typed on their page and stored by them. Nothing here
          ever sees a card number, an expiry date or a security code, which means there is no
          version of this app being breached that exposes your card.
        </p>
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          You can also pay once with Alipay or WeChat Pay instead of subscribing. Those details
          go to the payment provider in the same way and never reach us either.
        </p>
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          Stripe tells us what you have bought: that a subscription or a pass started, renewed or
          ended, which plan it is, and an identifier that links it to your account. That is what
          the app records. We also keep Stripe&rsquo;s own message about the payment as the
          receipt for it, which for a completed checkout can include the name and email address
          you gave Stripe. It is kept privately, and closing your account deletes it along with
          everything else &mdash; nothing about you is held back from that.
        </p>
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          Stripe keeps its own record of the payment regardless, because it is the company that
          took the money and is required to. Deleting your BandUp account does not reach into
          Stripe&rsquo;s books, and nothing here claims it does.
        </p>
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          Stripe is a separate company and handles your payment information under{" "}
          <a
            href="https://stripe.com/privacy"
            className="underline underline-offset-2 hover:text-slate-900"
            rel="noreferrer noopener"
            target="_blank"
          >
            its own privacy policy
          </a>
          . It needs your name, email and card to process a payment, and it uses that
          information to detect fraud, which is the reason payment works at all.
        </p>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          If you never subscribe, none of this applies to you and no payment company is involved
          in your account at all.
        </p>
      </section>

      <section className="card">
        <h2 className="heading-rule text-base font-semibold text-slate-900">
          Deleting your data
        </h2>
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          Without an account everything is on your device, so deleting it is entirely in your
          hands and takes effect immediately:
        </p>
        <ul className="mt-4 space-y-3">
          <li className="flex gap-3 text-[0.9375rem] leading-7 text-slate-700">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            Easiest, on the web and in the app alike: <strong>Clear this device</strong> on your
            account page. It empties everything BandUp is keeping in this browser.
          </li>
          <li className="flex gap-3 text-[0.9375rem] leading-7 text-slate-700">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            On the web you can also clear site data for this site in your browser&rsquo;s
            settings, and in the app you can delete BandUp from your device. Its storage goes
            with it.
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
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          BandUp is a study tool for people preparing for an English exam and is not aimed at
          children under 13. Without an account it collects nothing that identifies anybody. With
          one it holds an email address, and whatever else you choose to add, which is why the
          age limit exists at all. If you are in the EU or the UK and under 16, the law may
          require a parent&rsquo;s permission before an account is made in your name — please ask
          them first.
        </p>
      </section>

      {/*
        Who is answerable for the data.

        GDPR Article 13 requires the controller's identity and contact details
        to be given at the point personal data is collected, and it means a
        person or a company rather than a product name — "BandUp" is not an
        entity anybody can write to or complain about. The UK GDPR and Hong
        Kong's PDPO ask for the same thing in their own words.

        It is repeated here rather than linked from /terms because a reader who
        has come to the privacy page to find out who holds their data should
        find the answer on it.
      */}
      <section className="card">
        <h2 className="heading-rule text-base font-semibold text-slate-900">
          Who is responsible for your data
        </h2>
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          BandUp is run by <strong>Adam Yiu</strong>, as an individual rather than through a
          company. That is the person responsible for the data described on this page — what the
          GDPR calls the controller — and the person any request or complaint reaches.
        </p>
        <address className="mt-3 not-italic text-[0.9375rem] leading-7 text-slate-700">
          Adam Yiu
          <br />
          11B, Chai Kung Mansion
          <br />
          Taikoo Shing
          <br />
          Hong Kong
        </address>
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          Write to{" "}
          <a href="mailto:hello@bandup.life" className="underline underline-offset-2 hover:text-slate-900">
            hello@bandup.life
          </a>{" "}
          to ask what is held about you, to have it corrected, or to have it deleted. If you are
          in the EU or the UK you also have the right to complain to your national data protection
          authority; in Hong Kong that is the Privacy Commissioner for Personal Data.
        </p>
      </section>

      <section className="card">
        <h2 className="heading-rule text-base font-semibold text-slate-900">
          Changes to this policy
        </h2>
        <p className="mt-3 text-[0.9375rem] leading-7 text-slate-700">
          If what BandUp stores or sends ever changes, this page changes with it and the date
          at the top is updated. The version you are reading ships inside the app you have
          installed, so it always describes that version.
        </p>
      </section>

      <div className="card flex flex-col items-center gap-3 text-center">
        <p className="text-[0.9375rem] text-slate-700">
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
