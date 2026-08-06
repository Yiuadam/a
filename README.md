# BandUp — IELTS practice app

A personalised IELTS preparation app: a five-minute placement test estimates your band
(1–9), a study plan is built around your weak spots, and you practise all four skills with
exam-format material and an AI examiner.

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

**See [DEPLOY.md](DEPLOY.md) for the full setup.** Short version: connect the repo to Vercel
once and every push to `main` deploys itself to the same permanent URL — the production
domain never changes between deployments, so a bookmark or an App Store listing keeps
working. Pull requests get their own preview URLs.

Vercel is the fastest route — it is the first-party host for Next.js, so there is nothing to
configure:

```bash
npm i -g vercel
vercel                                    # links the project and deploys a preview
vercel env add ANTHROPIC_API_KEY          # paste your key, choose all environments
vercel --prod                             # ship it
```

Or push this repo to GitHub and click **Import Project** at
[vercel.com/new](https://vercel.com/new) — Vercel detects Next.js, builds it, and gives you a
URL. Add `ANTHROPIC_API_KEY` under Settings → Environment Variables, then redeploy.

The AI routes declare `maxDuration = 60`, which is the ceiling on Vercel's Hobby plan. On Pro
you can raise it if you want longer generations.

### Vercel or Cloudflare?

Both work. They trade off differently for this app:

| | Vercel | Cloudflare Workers |
|---|---|---|
| Setup | Zero config, first-party Next.js | Needs the `@opennextjs/cloudflare` adapter and a `wrangler` config |
| Long AI calls | Hobby caps a request at 60s; Pro at 300s | Bills CPU time, and waiting on the Claude API costs almost none — long generations are not a problem |
| Free tier | Generous for hobby traffic | More generous, and cheaper as traffic grows |
| Next.js coverage | Complete by definition | Very good via the adapter, but occasionally lags new Next features |

Start on Vercel — it is the fastest path to a working URL, and everything here
fits inside 60s. Move to Cloudflare if the per-request time limit or bandwidth
cost becomes the binding constraint. Both are already wired up:

```bash
npm run cf:preview                      # run the Worker build locally first
npx wrangler secret put ANTHROPIC_API_KEY
npm run cf:deploy                       # build + publish
```

`open-next.config.ts` and `wrangler.jsonc` hold the Worker configuration; the
app name (`bandup`) and the `nodejs_compat` flag are set there. The Worker build
has been verified locally — pages render and the API routes respond.

Everything except the three AI routes is static or client-side, so it also deploys unchanged
to Netlify or any Node host (`npm run build && npm start`).

## How it is put together

```
app/
  page.tsx                    dashboard
  placement/                  adaptive placement test
  plan/                       generated study plan
  practice/                   test index + on-demand generation
    reading/                  reading test runner (?id=…)
    listening/                listening test runner (?id=…, speech synthesis)
    writing/                  writing task + AI grading
  speaking/                   AI speaking examiner
  resources/                  exam guides
  api/
    grade/writing/            Claude grading, structured output
    grade/speaking/           Claude grading, structured output
    generate/                 new reading/listening test generation
    define/                   plain-English word lookup
components/                   band badge, question renderer, timer
data/                         the content bank (JSON)
lib/
  band.ts                     scoring and band conversion
  placement.ts                adaptive engine: IRT ability estimate and item selection
  glossary.ts                 built-in grammar and exam term definitions
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
