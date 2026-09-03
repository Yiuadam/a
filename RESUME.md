# Resume notes

Written for whoever picks this up after a usage window closes. Read it top to
bottom before touching anything — the first section is the part people get wrong.

## Read this first

**Background agents do not survive a session.** Nothing that was running is
running now. There is no queue that drains on its own and no scheduler that
restarts them. "Resuming" means re-spawning the work listed under
[What was in flight](#what-was-in-flight), from the descriptions there.

**Local branch is `claude/avatar-glass-clear-extension-ingx18`. It pushes to
`claude/writing-swipe-and-round-cards`, which is PR 180.** The names differ and
that is not a mistake — the local branch was cut later. Always push with the
explicit refspec below or the work lands on a branch the preview does not build:

    git -c credential.helper=osxkeychain push \
      origin HEAD:refs/heads/claude/writing-swipe-and-round-cards

`git push` on its own fails in this environment — the credential helper is not
picked up unless it is named on the command line. That is the only reason the
`-c` is there.

**Preview:** https://pr-180-bandup.ad1m.workers.dev — rebuilds on each push.
**Never deploy to production.** The owner reviews the preview and decides.
See `CLAUDE.md`; this has not changed.

## Where things stand

    git log --oneline -14      what has landed
    git status --short         what an agent left half-written

Landed and pushed, newest first:

  - the examiner nudges instead of sitting silent, the tutor reads speaking
    results, every voice is British, and the privacy page says so — see the log
    for the exact commits
  - `249b6e7` twenty defects in the ten new papers — two heading tasks whose key
    was the printed list read straight down, one percentage key the marker turned
    into the wrong number, six papers asking questions out of passage order
  - `f3fef29` this file
  - `b4586e0` Android parity — `color-scheme` was never declared for Warm, the
    default theme, so a phone in dark mode got a cream page wearing the browser's
    dark furniture; plus `appearance`, the date glyph, autofill, and two
    cross-platform scroll bugs
  - `0cb94bd` Google sign-in taken out of the iOS app — it opened Safari and the
    session never came back, so it had never worked; also settles Guideline 4.8
  - `da3a244` one-skill retake
  - `fe1ea6d` per-question review on the results page
  - `492f017` a distinct voice per speaker, and numbers spoken as numbers
  - `edf724c` the identity row is actually deleted on account closure — until
    this, a deleted user could never sign up again with the same Google or Apple
    account

The iOS bundle in `ios/App/App/public/` was rebuilt and synced at `249b6e7`.
Verified in the bundle: `IS_MOBILE_BUILD` is inlined `true`, so the Google
provider is filtered out. The component's code is still present in the chunk —
it is shared with the web build and not tree-shaken — but it never renders.
To redo after any change:

    NEXT_PUBLIC_API_BASE=https://bandup.life npm run build:mobile
    npx cap sync ios

Then open `ios/App/App.xcworkspace` and run to the device. Builds last seven
days — the Apple Developer enrolment is not done, so there is no TestFlight.

## Still open

Nothing is running. Each of these is written so it can be picked up without
this conversation.

### Exam fidelity — the current programme

An audit against the computer-delivered IELTS spec produced this list. Some of
it is already done; what remains is here. The audit's own correction is worth
repeating because it saved a large piece of unnecessary work: **listening is
already four parts of ten**. `composeMock` combines four papers into a 40-question
sitting and `LISTENING_PART` classifies all 31 into parts 1-4. There is no
structural rewrite needed there.

  - **Table and flow-chart completion cannot be drawn.** `CompletionQuestion` is
    one line and one blank, rendered as a single text input per question, so a
    table completion could only ever look like a numbered list of fragments.
    This needs a grid renderer before any content can follow.
  - **Diagram, plan and map labelling.** No image, SVG or coordinate field
    exists. The answer is a letter or a word, so the marking needs nothing new —
    what is missing is a diagram spec and its renderer. The product already
    draws figures from data (`lib/chart.ts`, writing Task 1), which is the model
    to follow rather than shipping images.
  - **Listening audio runs about half the real length.** Scripts average 607
    words a paper, roughly 4-5 minutes at natural pace, against the real ~30
    minutes for four parts. The question count is right; the audio is short. This
    is an estimate from word count, not a measured duration — measure before
    acting.
  - **Matching sentence endings** is never authored, though `MatchingQuestion`
    and its renderer already support the shape. Content only.
  - **General Training reading** is not representable: `ReadingTest` has no
    `variant`. The mock says it is Academic now, which is honest, but a GT
    candidate has no paper. `lib/exam/mock.ts` names its own tracking issue.
    Writing already has both variants and practice offers all 40 tasks.

### Older, still true

  - **UI sweep** across three widths and three themes, for layout breaks and

