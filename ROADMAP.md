# BandUp — where the project stands and what comes next

This is the planning document. It records what has actually been verified to
work, where the app falls short of the exam it prepares people for, and the
order the remaining work should be done in. It is meant to be edited as things
land — a milestone that ships gets struck through here, not quietly forgotten.

Last reviewed: 8 August 2026, against `main` at the merge of #37 and #38.

## Where it stands today

Everything through #38 is merged and deployed. Everything CI checks passes on
`main`:

| Check | Result |
|---|---|
| `npx eslint .` | clean |
| `npm run build` | 17 routes — 13 static, 4 dynamic API routes |
| `node scripts/validate-content.mjs` | every answer key reachable and well formed |
| `node scripts/simulate-placement.mjs` | worst bias 0.41–0.45 bands, worst RMSE 0.84–0.90, over three runs — the simulation is stochastic, so a single figure would overstate its precision |
| `npm run build:mobile` | static bundle written to `out-mobile/` |
| `npm test` | 31 tests pass |

The content bank, counted rather than estimated:

| | Shipped |
|---|---|
| Placement items | 108 — 18 per CEFR level, across grammar, vocabulary and reading |
| Reading | 4 passages, 744–814 words, 13 questions each |
| Listening | 6 sections, 10 questions each — Parts 1, 2, 3 and 4 all represented |
| Writing | 7 tasks — 2 Academic Task 1 (both still tables), 1 General Training letter, 4 Task 2 essays |
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

### ~~Listening covers 2 of the 4 parts~~ — closed by #31

All four parts now have material. The two additions are `listening-5`, a
reserve manager briefing volunteers (Part 2 — one speaker, social context), and
`listening-6`, three geography students planning fieldwork with their tutor
(Part 3 — four voices to track, the part most candidates find hardest).

Six sections in total: two Part 1 dialogues, one Part 2 talk, one Part 3
discussion, two Part 4 lectures. What is still missing from listening is *question
types*, not parts — see above.

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

Half the plumbing is already there and unused: every task in
`data/writing-tasks.json` carries `variant: "academic" | "general"`. Nothing
reads it. #14 is closer than this section has been implying.

### Writing Task 1 is still two tables — but the blocker is gone

Academic Task 1 asks candidates to describe a line graph, bar chart, pie chart,
table, process diagram or map. Both shipped Academic tasks are tables, so the
most common prompts in the real exam are still the ones a learner cannot
practise here.

What has changed is that the thing standing in the way is no longer standing
there. #34 shipped `lib/chart.ts` and `components/Chart.tsx`: line, bar
(grouped and stacked) and pie, rendered as SVG from data, with a text
description generated for screen readers. `kind` is a discriminant, so process
diagrams and maps arrive as new members of `ChartSpec` rather than a rewrite.

**Nothing uses it yet.** Every task in `data/writing-tasks.json` is still
`dataTable`; not one carries a `chart`. This is now purely a content job —
which makes it among the cheapest high-value items left on this list, and it
should move up accordingly.

### Progress lives in one browser and nothing else

`lib/store.ts` keeps everything in `localStorage` under a single key. Clearing
site data, switching from phone to laptop, or reinstalling the app loses the
placement result, the four-week plan and every saved word. For a study plan
measured in weeks, on a product heading for the App Store, that is a hole worth
closing — and it can be closed without building accounts.

### The scoring logic is now half tested — and the untested half is the band

There are 31 tests where there were none. `tests/marking.test.mjs` pins
`isCorrect` and `roundToHalf` from `lib/band.ts`, `tests/questions.test.mjs`
covers the question-set helpers, and #35 and #37 added snapshot and transcript
tests.

But the specific failure this section was written about is still open:

- **`rawToBand` has no test.** It is the function that turns a raw score into
  the number a learner books a test date on, and nothing checks it. Of
  everything in this document it is the cheapest to fix and the worst to get
  wrong.
- `lib/plan.ts`, `lib/review.ts` and `lib/advice.ts` remain untested.

A wrong number, confidently displayed, is still the failure mode with the least
warning attached to it.

### iOS is documented but has never been built

`APPSTORE.md` is a good plan, not a completed path. There is no `ios/` project
in the repo, the two required `Info.plist` permission strings have not been
applied, no app icon is wired up, and the native speech recogniser has never
run on hardware — the document says so itself. The whisper.cpp plugin added by
#37 is in the same position: written, documented, never compiled.

Two blockers here have gone. `/privacy` shipped in #30 and was extended in #37,
so the public privacy policy URL Apple requires now exists. And #38 took the
IELTS trademark out of the bundle identifier — `com.bandup.ielts` became
`com.yiuadam.bandup`. That one was worth catching before submission rather than
after: Apple fixes a bundle id permanently at first upload, so it is the single
item on this list that could not have been corrected later.

## What to build, in order

The ordering rule: fix what makes the practice unrepresentative before adding
anything new, because a learner who is well prepared for the wrong exam is
worse off than one who knows they have not started.

If only three things get done, they should be **#5** (matching headings — the
type most likely to cost a real learner real marks), **#14** (ask Academic or
General Training — the cheapest way to stop misleading half the audience) and
**#18** (chart-based Task 1 prompts — the renderer landed in #34 and sits
unused, so this is now content alone).

The previous list named #22, the privacy policy. That shipped in #30. A test
for `rawToBand` is the strongest candidate for a fourth: an hour's work
guarding the number the whole app is judged by.

### M1 — Make the practice representative

The largest gap and the one this repo is best equipped to close, since the
content pipeline, the validator and the house style are already in place.

- Matching headings — #5, the single highest-value type.
- The other matching types: information, features, sentence endings — #6.
- Yes/No/Not Given, distinguished from True/False/Not Given — #7.
- Note, table and flow-chart completion, diagram labelling, short answer — #8.
- The missing listening types: matching, map/plan/diagram labelling,
  short answer — #9.
- ~~Part 2 and Part 3 listening material — #10.~~ **Shipped in #31.**

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

- ~~A component rendering chart data as SVG, so prompts are authored as data
  rather than drawn — #17.~~ **Shipped in #34**: `lib/chart.ts` and
  `components/Chart.tsx`, line/bar/pie, with `kind` left as a discriminant so
  diagram labelling in reading and map labelling in listening can reuse it.
- Line graph, bar chart, pie chart, process diagram and map-comparison
  tasks — #18. **Now unblocked and unstarted** — no task in
  `data/writing-tasks.json` carries a `chart` yet, so this is content only.

### M5 — Make progress durable and the numbers trustworthy

- Export and import the profile as a JSON file — #19. The cheap fix for the
  device problem: no server, no account, no privacy exposure. Worth doing
  before any account system, since it captures most of the value.
- Unit tests for `band.ts`, `plan.ts`, `review.ts` and `advice.ts`, wired into
  CI — #20. **Partly done**: `npm test` runs 31 tests in CI and covers
  `isCorrect`, `roundToHalf`, the question-set helpers, the server snapshots
  and the transcript cleaner. **`rawToBand` is still untested**, as are
  `plan.ts`, `review.ts` and `advice.ts`. Start with `rawToBand`.
- A band history view, so a learner sees the trend rather than one number — #21.

### M6 — The App Store submission

- ~~A privacy policy page in the app, at a stable URL — #22.~~ **Shipped in
  #30**, and extended in #37 to disclose the one thing an "on-device" engine
  still sends outward: the model download from Hugging Face.
- ~~Take the IELTS trademark out of the bundle identifier.~~ **Shipped in
  #38.** Not on the original list, and the only item that would have become
  permanent at first upload.
- Commit the `ios/` project, apply the permission strings and the icon, and
  work `APPSTORE.md` step 4 on a real iPhone — #23. Above all the speaking
  test, which is the documented highest-risk path and the one a reviewer will
  tap. This needs a Mac with Xcode and a $99/year Apple Developer membership,
  so it waits on hardware this repo cannot supply — and #37 added a second
  uncompiled native component, the whisper.cpp plugin, so more is queued behind
  that Mac now than there was.

## What is in flight

Branches and pull requests open against `main` as of this review. Recorded here
because work on a pushed branch with no pull request is work nobody can see.

| | State | Call |
|---|---|---|
| #36 — nav active state, plan polish, icon exploration | open, retargeted to `main` | **Split before merging.** The product changes should land. `app/icon-preview/` and `app/icon-final/` should not — `next build` publishes them, so an app in App Store review would ship its own design scratchpad at a guessable URL, along with 28 draft SVGs. |
| #39 — accounts phase 1 | open, needs a decision | Verified inert with `ACCOUNTS_ENABLED` unset: the flag check is the first statement in `checkAiUsage`, before any session or Supabase call. But it adds a third-party data processor and encodes a price list, and M5 puts #19 first on purpose. Not a merge to make on engineering grounds alone. |
| `claude/icons-gesture-family` | pushed, no PR | Three further commits of icon exploration on top of #36. Design exploration, not product. Should not be merged as-is. |
| #29 — privacy page | **closed** | Superseded: its commit reached `main` through #30. |

The pattern worth naming: #29, #36 and #39 were all opened against
`claude/english-exam-prep-app-rbklw7` or against nothing at all, and drifted
because a branch nobody merges into is a branch nobody notices. Open pull
requests against `main`.

## Risks worth watching

**Content volume is the real constraint.** Everything in M1 to M4 is writing,
and it has to be written from scratch — nothing may be adapted from published
material, because this app is going to the App Store. Each new question type
also needs a renderer and a validator rule, so "add matching headings" is a
code change and a content change together.

**The band number carries more weight than it deserves.** Until M2 lands, the
app reports bands from tests too short to support them. Worth being plain about
in the interface rather than only in this document.

**iOS is an unexercised path, and it grew.** The native speech recogniser has
never run on a device, and #37 added a whisper.cpp plugin in the same
condition — Swift source and a TypeScript bridge, neither ever compiled. These
are the things most likely to fail, and they fail in front of an App Review
tester rather than in CI.

**Claims about accuracy are the easiest thing here to get wrong.** #37 shipped
with a model note reading "Noticeably better on accented English" — plausible,
directional, and measured by nobody. It was corrected before merge, and
`TRANSCRIPTION.md` now carries both the rule and the procedure for earning the
claim back. The general form is worth keeping in view: every user of this app
is a non-native speaker, so a sentence about accented English is the sentence
they will weigh a decision on, and it is therefore the sentence that must be
true. The same applies to any band, any level and any "you are ready" the
interface ever shows.

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
