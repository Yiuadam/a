# BandUp — IELTS practice app

A personalised IELTS preparation app: a five-minute placement test estimates your band
(1–9), a study plan is built around your weak spots, and you practise all four skills with
exam-format material and an AI examiner.

[ROADMAP.md](ROADMAP.md) records what is built, where the app still falls short of the
exam, and the order the remaining work is being done in.

## What it does

**Placement test** — five or ten minutes, your choice, and it adapts as you go. This is
item response theory, the method real computer-adaptive exams use, not an up-a-bit /
down-a-bit staircase. Every answer is scored against a model of how likely it was, so
getting a C2 item right when the estimate says B1 moves the estimate a long way while
getting an A1 item right barely moves it at all; guessing is modelled explicitly, since a
four-option question gives a candidate who knows nothing one mark in four; and each next
question is chosen to be the one that will *tell the test the most*, not merely one at the
current level. The estimate stops early once it is precise enough. Questions come from a
bank of 108 and never repeat within three sittings.

`scripts/simulate-placement.mjs` runs thousands of simulated candidates of known ability
through the engine and fails CI if placement drifts: the five-minute test currently sits
within 0.4 of a band of the truth on average, the ten-minute test within 0.3.

**Wrong-answer review** — every test ends with the questions you missed, what you put, the
answer, and an explanation of why it is the answer. Above it sit two short lists — what went
well, what to work on — generated from the shape of your mistakes rather than your score.

**Tap-to-look-up** — every grammar and exam term in an explanation is underlined and opens a
plain-English definition from a built-in glossary, offline and instantly. Select any *other*
word anywhere in the app — a passage, a transcript, a question — and a "look up" button
appears; the AI tutor explains it in simple English, in the context of the sentence you were
reading, and the answer is cached for next time.

**Study plan** — a four-week cycle ordered by weakness: modules you have never tested come
first, then the ones with your lowest band. Weak skills flagged by the placement test add
extra review tasks. Set a target band and the plan tells you how realistic the gap is.

**Reading** — four full academic passages (750–950 words) with True/False/Not Given,
multiple choice and sentence completion. Auto-marked and converted to a band using the published
Academic Reading conversion table.

**Listening** — Section 1 (transactional dialogue) and Section 4 (academic lecture) style
tests, four in all. The script is read aloud by the browser's speech synthesis, one turn at a time, with
different voices per speaker and adjustable speed. The transcript stays hidden until you
submit, as in the real exam.

**Writing** — Task 1 (academic reports with data tables, and a General Training letter) and
Task 2 essays covering all four question types. Your response is graded by Claude against
the four official criteria, with a band per criterion, prioritised improvements, and your
weakest paragraph rewritten one band higher.

**Speaking** — a full three-part mock interview. The examiner asks questions out loud, your
answers are transcribed in the browser via the Web Speech API, and the transcript is graded
on Fluency and Coherence, Lexical Resource, Grammatical Range and Accuracy, and
Pronunciation — plus a band-8 model answer to your weakest response.

**Grammar and vocabulary practice** — two study sections that are not shaped like the exam,
because a learner who keeps failing the same tense needs to practise that tense rather than
sit another whole paper and discover the same thing. Ten grammar topics and eight vocabulary
topics, each opening with the rule in a few lines and then drilling it: you answer, find out
immediately whether you were right, and read why. No clock, no band score. Words you look up
anywhere in the app collect into a personal list on the vocabulary page — the most useful
word list a learner can have, because they did not choose it.

**Endless material** — the app can generate brand-new exam-format reading and listening
tests on demand, at your chosen difficulty and topic.

**Three themes** — Warm (cream paper and clay, the default), Light and Dark, switched from
the header and remembered on the device. The whole palette lives in CSS variables redefined
per theme, so no component carries theme-specific markup.

All content is original and written to match authentic IELTS format, register and
difficulty calibration. No real past-paper material is reproduced.

## Running it

```bash
npm install
cp .env.example .env.local   # add your Anthropic API key
npm run dev
```

Open http://localhost:3000.

The API key is only needed for the AI features (writing feedback, speaking examiner, test
generation). The placement test, study plan, and the bundled reading and listening tests
work without one.

## Deploying

**See [DEPLOY.md](DEPLOY.md) for the full setup.** Short version: the repo is
already connected to **Cloudflare Workers**, and every push to `main` deploys
itself to the same permanent address:

```
https://bandup.siksafe-realtime-ai-vision.workers.dev
```

That URL does not change between deployments, so a bookmark or an App Store
listing keeps working. It becomes `bandup.study` when that domain is ready —
a DNS change pointed at the same Worker, not a move.

`.github/workflows/deploy-cloudflare.yml` does the work. It needs two
repository secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) and skips
quietly without them. The Worker itself needs `ANTHROPIC_API_KEY` and, once
accounts are switched on, the Supabase variables — those live in Cloudflare,
not in this repository. See `.env.example`.

To build and publish by hand:

```bash
npm run cf:build     # required first — preview and deploy do not build
npm run cf:preview   # optional: run the Worker locally
npm run cf:deploy
```

`open-next.config.ts` and `wrangler.jsonc` hold the Worker configuration; the
app name (`bandup`) and the `nodejs_compat` flag are set there.

### Why Cloudflare rather than Vercel

The app ran on Vercel first, and Vercel is the easier start — it is the
first-party host for Next.js, so there is nothing to configure. Two things
decided the move:

- **Long AI calls.** Vercel's Hobby plan caps a request at 60 seconds, which is
  the ceiling the four AI routes are written against. Workers bills CPU time,
  and waiting on the Claude API costs almost none, so a slow generation is not
  a problem there.
- **One host, one bill, one set of secrets.** Running both meant every
  environment variable had to be set twice and could drift.

The cost is real and worth naming: Next.js support on Workers comes through the
`@opennextjs/cloudflare` adapter rather than from the framework's own vendor, so
it can lag new Next.js features. That is why `npm run cf:build` runs in CI on
every push — a change that breaks the Worker fails before it is merged rather
than when someone tries to deploy. **Do not add a `proxy.ts` or a
`middleware.ts`**; the adapter rejects Node middleware and the build will fail.

Everything except the three AI routes is static or client-side, so it also deploys unchanged
to Netlify or any Node host (`npm run build && npm start`).

## How it is put together

```
app/
  page.tsx                    dashboard
  placement/                  adaptive placement test
  grammar/                    grammar topics and drills
  vocabulary/                 vocabulary topics, drills and saved words
  plan/                       generated study plan
  practice/                   test index + on-demand generation
    reading/                  reading test runner (?id=…)
    listening/                listening test runner (?id=…, speech synthesis)
    writing/                  writing task + AI grading
  speaking/                   AI speaking examiner
  chat/                       ask a tutor — metered study assistant
  resources/                  exam guides
  privacy/                    privacy policy (App Store requires a public URL)
  api/
    grade/writing/            Claude grading, structured output
    grade/speaking/           Claude grading, structured output
    generate/                 new reading/listening test generation
    define/                   plain-English word lookup
    chat/                     tutor chat, multi-turn, capped and metered
components/                   band badge, question renderer, timer
data/                         the content bank (JSON)
lib/
  band.ts                     scoring and band conversion
  placement.ts                adaptive engine: IRT ability estimate and item selection
  glossary.ts                 built-in grammar and exam term definitions
  drills.ts                   drill types and per-topic best scores
  lookups.ts                  saved word lookups
  advice.ts                   post-test advice from the shape of the mistakes
  review.ts                   builds the wrong-answer review
  theme.ts                    theme store and pre-paint initialiser
  plan.ts                     study-plan rules
  descriptors.ts              condensed official band descriptors
  anthropic.ts                Claude client with structured outputs
  speech.ts                   Web Speech API wrappers
  store.ts                    localStorage profile
```

Progress is stored in the browser's `localStorage` — there is no account system and nothing
is sent to a server except the text you submit for AI marking.

Grading calls use Claude with structured outputs, so responses always match the expected
schema, and opt into server-side refusal fallbacks so a rare classifier decline is retried
transparently.

## Browser support

Listening playback and the speaking examiner use the Web Speech API. Speech synthesis works
in all modern browsers; speech *recognition* (for the speaking test) needs Chrome, Edge or
Safari. Where recognition is unavailable the speaking test falls back to typed answers.

## Disclaimer

BandUp is an independent study tool. It is not affiliated with or endorsed by IELTS, the
British Council, IDP or Cambridge English. Band scores it reports are practice estimates.
