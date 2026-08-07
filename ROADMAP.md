# BandUp — where the project stands and what comes next

This is the planning document. It records what has actually been verified to
work, where the app falls short of the exam it prepares people for, and the
order the remaining work should be done in. It is meant to be edited as things
land — a milestone that ships gets struck through here, not quietly forgotten.

Last reviewed: 7 August 2026, against `main` at the merge of #4.

## Where it stands today

Four pull requests have been merged and the app is deployed. Everything CI
checks passes on `main`:

| Check | Result |
|---|---|
| `npx eslint .` | clean |
| `npm run build` | 18 routes, 4 of them dynamic API routes |
| `node scripts/validate-content.mjs` | every answer key reachable and well formed |
| `node scripts/simulate-placement.mjs` | worst bias 0.39–0.47 bands, worst RMSE 0.85–0.88, over three runs — the simulation is stochastic, so a single figure would overstate its precision |
| `npm run build:mobile` | static bundle written to `out-mobile/` |

The content bank, counted rather than estimated:

| | Shipped |
|---|---|
| Placement items | 108 — 18 per CEFR level, across grammar, vocabulary and reading |
| Reading | 4 passages, 744–814 words, 13 questions each |
| Listening | 4 sections, 10 questions each |
| Writing | 7 tasks — 2 Academic Task 1 (both tables), 1 General Training letter, 4 Task 2 essays |
| Speaking | 6 topics in each of the three parts |
| Grammar | 10 topics × 8 drill questions |
| Vocabulary | 8 topics × 8 drill questions |
| Glossary | 70 terms |

What works well and should not be disturbed: the IRT placement engine and its
simulation harness, the tap-to-look-up glossary, the wrong-answer review, and
the discipline that every question carries an explanation.

## The gap between this app and the exam

This is the part that matters. A learner's complaint after the real exam will
not be that the app was slow — it will be that the exam contained things the
app never showed them.

### Question types: reading covers 3 of 11, listening 2 of about 8

Academic Reading uses eleven question types. BandUp has three.

| Type | In BandUp |
|---|---|
| Multiple choice | yes |
| True / False / Not Given | yes |
| Sentence & summary completion | partly — sentence completion only |
| **Matching headings** | **no** |
| **Matching information to paragraphs** | **no** |
| **Matching features** | **no** |
| **Matching sentence endings** | **no** |
| **Yes / No / Not Given** (writer's views) | **no** |
| **Note / table / flow-chart completion** | **no** |
| **Diagram label completion** | **no** |
| **Short-answer questions** | **no** |

Matching headings appears in most Academic Reading papers and is widely the
type candidates lose most marks on. A learner who has drilled only True/False/
Not Given, multiple choice and gap-fill will meet it for the first time under
exam conditions.

Listening is the same story: only completion and multiple choice are
implemented. Matching, plan/map/diagram labelling and short-answer are absent.

### Listening covers 2 of the 4 parts

The four shipped sections are two Part 1-style dialogues (booking a class,
renting an allotment) and two Part 4-style lectures. Part 2 — a single-speaker
talk in a social context — and Part 3 — a discussion between up to four people
in an academic one — have no material at all. Part 3 is the hardest part of the
paper for most candidates, because it has several voices to track.

### There is no full-length paper, and short tests give coarse bands

The app offers 13-question reading tests and 10-question listening sections.
There is no way to sit a real paper: 3 passages and 40 questions in 60 minutes,
or 4 sections and 40 questions in 30.

This is not only about authenticity. `rawToBand` scales a short test's raw
score up to 40 and reads the official conversion table, which makes each
question worth three or four scaled marks and the resulting band very coarse:

```
listening — 10-question test as shipped     a real 40-question paper
  10/10 → band 9                              one mistake costs 0 bands
   9/10 → band 8    one mistake = 1.0 band
   8/10 → band 7.5  one mistake = 0.5 band
   7/10 → band 6.5  one mistake = 1.0 band
```

A learner who mishears a single postcode drops a whole band. The number the app
shows them is the number they will plan their life around — book a test date,
tell an employer, decide whether to apply — so it needs to be worth trusting.
Full-length papers fix the authenticity and the precision in one move.

### General Training does not exist

Roughly half of IELTS candidates worldwide sit General Training rather than
Academic — it is the version required for migration to the UK, Australia,
Canada and New Zealand. BandUp has one GT letter and nothing else: no GT
reading, and no point anywhere at which it asks which exam you are sitting. A
GT candidate is currently served Academic material throughout and is never told.

### Writing Task 1 is two tables

Academic Task 1 asks candidates to describe a line graph, bar chart, pie chart,
table, process diagram or map. Both shipped Academic tasks are tables. The most
common prompts in the real exam are the ones a learner cannot practise here,
and unlike the other gaps this one needs a small chart-rendering component
before the content can be written at all.

### Progress lives in one browser and nothing else

`lib/store.ts` keeps everything in `localStorage` under a single key. Clearing
site data, switching from phone to laptop, or reinstalling the app loses the
placement result, the four-week plan and every saved word. For a study plan
measured in weeks, on a product heading for the App Store, that is a hole worth
closing — and it can be closed without building accounts.

### The scoring logic has no tests

`lib/band.ts`, `lib/plan.ts`, `lib/review.ts` and `lib/advice.ts` are pure
functions carrying the logic a learner trusts most, and none of them has a
single test. The content validator checks the data; the placement simulation
checks the engine; nothing checks that a raw score becomes the right band or
that answer normalisation accepts "sixty-two" for "62". These are cheap tests
to write and they guard against the worst kind of failure — a wrong number,
confidently displayed.

### iOS is documented but has never been built

`APPSTORE.md` is a good plan, not a completed path. There is no `ios/` project
in the repo, the two required `Info.plist` permission strings have not been
applied, there is no app icon, and the native speech recogniser has never run
on hardware — the document says so itself. There is also no privacy policy
page anywhere in the app or the repo, and Apple will not accept a submission
without a public privacy policy URL, particularly from an app that asks for the
microphone.

## What to build, in order

The ordering rule: fix what makes the practice unrepresentative before adding
anything new, because a learner who is well prepared for the wrong exam is
worse off than one who knows they have not started.

If only three things get done, they should be **#5** (matching headings — the
type most likely to cost a real learner real marks), **#14** (ask Academic or
General Training — the cheapest way to stop misleading half the audience) and
**#22** (the privacy policy page — small, and the App Store goal is blocked
without it).

### M1 — Make the practice representative

The largest gap and the one this repo is best equipped to close, since the
content pipeline, the validator and the house style are already in place.

- Matching headings — #5, the single highest-value type.
- The other matching types: information, features, sentence endings — #6.
- Yes/No/Not Given, distinguished from True/False/Not Given — #7.
- Note, table and flow-chart completion, diagram labelling, short answer — #8.
- The missing listening types: matching, map/plan/diagram labelling,
  short answer — #9.
- Part 2 and Part 3 listening material — #10.

Each of these is a code change as well as a content change: `lib/types.ts`,
`components/TestQuestions.tsx` and `scripts/validate-content.mjs` all have to
learn every new type.

### M2 — Full-length papers

- A 3-passage, 40-question Academic Reading paper against a 60-minute clock — #11.
- A 4-section, 40-question Listening paper against a 30-minute clock — #12.
- A full Writing paper: Task 1 and Task 2, 60 minutes, marked together — #13.

Both papers report the band from the real 40-question table, dropping the
scaling approximation entirely.

### M3 — Ask which exam they are sitting

- An Academic / General Training choice at first run, with the plan, placement
  and practice index all filtering on it — #14. Worth doing on its own and
  early: it makes the gap visible to a GT learner before the content exists.
- GT Reading sections 1–3, with the notice-and-advertisement formats Section 1
  uses, and GT's own stricter conversion table — #15.
- More GT letters, across all three registers — #16.

### M4 — Writing Task 1 beyond tables

- A component rendering chart data as SVG, so prompts are authored as data
  rather than drawn — #17. Diagram labelling in reading and map labelling in
  listening want the same component, so it should be designed for all three.
- Line graph, bar chart, pie chart, process diagram and map-comparison
  tasks — #18.

### M5 — Make progress durable and the numbers trustworthy

- Export and import the profile as a JSON file — #19. The cheap fix for the
  device problem: no server, no account, no privacy exposure. Worth doing
  before any account system, since it captures most of the value.
- Unit tests for `band.ts`, `plan.ts`, `review.ts` and `advice.ts`, wired into
  CI — #20.
- A band history view, so a learner sees the trend rather than one number — #21.

### M6 — The App Store submission

- A privacy policy page in the app, at a stable URL — #22. A hard blocker:
  Apple will not accept a submission without one, least of all from an app
  that asks for the microphone. It is also small, and can be done now.
- Commit the `ios/` project, apply the permission strings and the icon, and
  work `APPSTORE.md` step 4 on a real iPhone — #23. Above all the speaking
  test, which is the documented highest-risk path and the one a reviewer will
  tap. This one needs a Mac with Xcode and a $99/year Apple Developer
  membership, so it waits on hardware this repo cannot supply.

## Risks worth watching

**Content volume is the real constraint.** Everything in M1 to M4 is writing,
and it has to be written from scratch — nothing may be adapted from published
material, because this app is going to the App Store. Each new question type
also needs a renderer and a validator rule, so "add matching headings" is a
code change and a content change together.

**The band number carries more weight than it deserves.** Until M2 lands, the
app reports bands from tests too short to support them. Worth being plain about
in the interface rather than only in this document.

**iOS is an unexercised path.** The native speech recogniser has never run on a
device. It is the thing most likely to fail, and it fails in front of an App
Review tester rather than in CI.

**One key, one dependency.** Writing feedback, the speaking examiner, word
lookup and test generation all stop working if `ANTHROPIC_API_KEY` is missing
or the API is unreachable. The bundled tests, placement and plan do not — that
separation is worth preserving as the app grows.

## How the project runs

Set out in `CLAUDE.md` and unchanged: work on a branch, run everything CI runs
plus a real browser check, push, open a pull request, wait for the checks, merge
it. Vercel deploys `main` automatically, so merging is what makes a change live.

Production is <https://a-nine-peach.vercel.app>.

The backlog lives in GitHub issues, one per item above, labelled by milestone.
This document is the shape of the plan; the issues are the state of it.
