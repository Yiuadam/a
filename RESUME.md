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

## What was in flight

Re-spawn these. Each is written so it can be handed over without this
conversation.

**UI sweep** across three widths and three themes, for layout breaks and
centring.

**Re-measure the listening pace.** The 165 wpm figure was measured on aura-1
recordings, and every one of them has been retired — so the number no longer
describes the app and nothing should be calibrated against it. Re-measure Part 4
words per minute and silence share on the new aura-2 recordings first. Real
Part 4 runs 133.5 wpm inclusive of pauses, ~169 articulation, 21% silence.
Neither Aura model takes a speed parameter; the only lever is client
`playbackRate` with `preservesPitch`, which practice exposes and the mock pins
at 1.

**Structural pauses** — the announced gaps a real paper gives for reading ahead
and checking — are described but not built. They need announcements written from
scratch, and the 30-minute mock clock has to absorb three or four minutes of
added silence per paper.

**`app/privacy/page.tsx` still says you can sign in with Google.** No longer true
inside the app.

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
  - **Two of the four listening voices are Australian.** Neither Aura model can
    cast four British speakers: aura-1 offered British, British, Irish, American;
    aura-2 offers British, British, Australian, Australian. The one without an
    American in it was chosen, since removing American was the brief and a
    candidate genuinely meets Australian in a real paper. That is 66 of 676
    recordings, 9.8%, all of them the third and fourth speakers in multi-speaker
    seminars. If the owner wants pure British it means two speakers per paper.
  - **The tutor is automatic, with no switch.** A learner who would rather it did
    not read their speaking has one lever: clearing their history, which deletes
    the interviews entirely. There is no setting that keeps the results but
    withholds them. The owner should know this was decided; the cheapest reversal
    is a default-on switch, one line of UI, identical behaviour for anyone who
    never touches it.
  - **The date picker.** The field is this product's design on every platform
    now. The sheet that opens when it is tapped is an OS dialog and no stylesheet
    reaches it. Replacing it means building a picker and losing the native one's
    accessibility and localisation.
  - **The longest-option cue and the listening block overlap** are still open —
    see the two entries above; nothing about the marking retry changed them.
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
  - `components/exam/MockResults.tsx` records no review for the speaking module,
    so a mock-exam interview reaches the tutor as a band and a date rather than
    as answers. A Standard-tier interview calls no `addResult` at all and leaves
    no record of any kind.
  - Two comments cite `lib/tutor/consent.ts`, which was deleted, and describe a
    consent switch that no longer exists: `components/exam/MockRetakeResults.tsx:191`
    and `lib/exam/mock.ts:319`. Comments only — nothing breaks.
  - `SENTENCE_GAP_MS` and `SPEAKER_CHANGE_GAP_MS` in `lib/exam/playback.ts` say
    320 ms was measured from the MP3s the server serves. Those MP3s are retired,
    so the provenance is stale even if the number still happens to be right.
  - All 676 listening recordings and 1,933 examiner prompts regenerate on first
    play, because the cache version moved. Nothing breaks while they do: a miss
    generates and stores one file, exactly as a brand-new paper does. The first
    listener per paper waits on the provider; everyone after reads R2.
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
