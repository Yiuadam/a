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

## What was in flight

Re-spawn these. Each is written so it can be handed over without this
conversation.

**The examiner nudge.** After a candidate gives a short answer the examiner sits
silent for up to 55 seconds before moving on, which in a real Part 1 would never
happen. The design was settled: a prompt after a measured pause, once, then the
next question. This is the highest-value item on the list — it is the difference
between a convincing examiner and an awkward one.

**British voices everywhere, and Part 4's rate.** Watch the trap: on Workers AI,
`athena` is British in aura-1 and **American** in aura-2-en. The only British
aura-1 voices are `athena` and `helios`; `angus` is Irish. Real Part 4 runs
133.5 wpm inclusive of pauses, ~169 articulation, 21% silence.

**The tutor reading speaking results.** It picks the lowest-scoring sitting on
its own and reads the results rather than being handed a transcript. Files were
mid-write when the window closed: `lib/tutor/`, `components/TutorChat.tsx`,
`tests/tutor-speaking-context.test.mjs`. A privacy paragraph still needs to say
that the tutor reads transcripts, and `app/privacy/page.tsx` still claims you
can sign in with Google — no longer true inside the app.

**UI sweep** across three widths and three themes, for layout breaks and
centring.

## Decisions waiting on the owner

  - **The longest option is correct 79% of the time** in reading-21..30 and 77%
    in reading-1..20. The new papers inherited the cue rather than introducing
    it, so fixing only the ten leaves "always pick the longest" working. It is a
    102-question sweep across all thirty, or nothing.
  - **Ten of ten new listening papers, and eleven of nineteen old ones,** let the
    second question block start before the first one ends. Same argument: a
    bank-wide pass or none.
  - **`normalise()` strips a dot between digits,** which is what makes `930` mark
    as `9.30`. Fixing it for decimals costs the time tolerance unless
    `CompletionQuestion` gains an `accept` field first. Three parts, its own
    change: protect the dot, add `accept`, restore the two time keys.
  - **The date picker.** The field is this product's design on every platform
    now. The sheet that opens when it is tapped is an OS dialog and no stylesheet
    reaches it. Replacing it means building a picker and losing the native one's
    accessibility and localisation.
  - **Ten backdrop-filter surfaces cover ~90% of the dashboard viewport** at a
    15px touch radius. That is the thing most likely to make a mid-range Android
    stutter. The radius is already an owner-chosen value, so moving it is the
    owner's call.

## Known-broken, so nobody re-diagnoses it

  - `.input`'s focus ring is dead on **every** platform: `.input` sets a plain
    `box-shadow`, which beats the layered `focus:ring-4` utility, while
    `focus:outline-none` still removes the browser's own. A focused field shows
    nothing but a caret. The fix needs weight above `html[data-theme] .input` and
    below `[data-exam] .input:focus`.
  - `--header-h` is 60px; the header actually draws 64.75px. The exam shell
    subtracts the variable, so it is ~4.75px out on every platform. Entangled
    with the iOS native chrome, which is why it was left.
  - `components/speaking/SpeakingSession.tsx` restarts recognition from `onend`
    synchronously and, on failure, just stops — the mic dies mid-answer with no
    message. On Android Chrome `continuous` is not honoured, so that boundary is
    hit every few seconds rather than every minute.
  - Tests: any failure in `tests/tutor-*`, `tests/server-listening-audio-*` or
    `tests/listening-*` is in-flight agent work, not a regression. Confirm by
    stashing the dirty files and re-running.
  - CI is Node 22, local is Node 24. `NextResponse` is undefined on 22 in
    `tests/cutover-write-barrier.test.mjs`.

## Before any push

    npx eslint .
    npm run build
    npm test
    node scripts/validate-content.mjs
    node scripts/simulate-placement.mjs
    npm run build:mobile
    npm run cf:build
    node scripts/check-delivery.mjs

And exercise the change in a real browser. A preview the owner has to debug is
worse than no preview.
