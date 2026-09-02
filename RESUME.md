# Where this session got to

Written because the usage window was about to reset. Everything below is either
committed and pushed, or sitting uncommitted in the working tree with an agent
that was mid-write on it.

## How to resume

Background agents do not survive a session. Nothing below is running any more —
re-spawn what you want from the notes here. Committed work is safe on the branch.

    git log --oneline -14        what landed
    git status --short           what an agent left half-written

## Pushed and verified

Branch `claude/writing-swipe-and-round-cards`, preview at
https://pr-180-bandup.ad1m.workers.dev

  da3a244  one-skill retake and the standing band on history
  fe1ea6d  per-question results breakdown with derived suggestions
  492f017  a voice per speaker, and numbers spoken properly
  edf724c  identity row actually deleted; privacy page corrected
  77b8b0a  ten reading papers and ten listening papers
  fb895cb  eight answer-key corrections
  74bf1eb  difficulty and task-type filter bars
  339f421  speaking bank doubled

## Uncommitted, and whose

Six test failures in the tree, all in files an agent held when the window closed.
None of them come from the commits above — that was checked before pushing.

  lib/listening-audio.ts, app/api/listening-audio/route.ts   British-accent agent
  lib/examiner-audio.ts, app/api/examiner-audio/route.ts     memory fix, separate session
  lib/tutor/, tests/tutor-*.test.mjs                         tutor-with-transcripts agent
  components/speaking/SpeakingSession.tsx                    examiner nudge agent
  components/account/SignedOut.tsx, APPSTORE.md              App Review fixes agent
  data/reading-2*.json, data/listening-2*.json               new-paper defect fixes
  app/globals.css, AccountIdentityForm.tsx                   Android web audit

Resume by re-reading each agent's report, or re-running the work from the briefs
recorded in the transcript.

## Decisions waiting on the owner

  - Four-speaker listening parts cannot be cast entirely British on Aura-1, which
    has only athena and helios. Either accept a mixed-accent cast, or move to
    aura-2-en and regenerate every cached recording (598 of 676 currently keep
    their keys). Note athena is British in aura-1 and AMERICAN in aura-2-en.
  - Part 4 is delivered at 165 wpm against a measured real-IELTS 133.5. Slowing the
    voice or raising the silence share are both open; real IELTS Part 4 is 21%
    silence.
  - The marker's normalise() strips a "." between two digits, so 3.8 and 38 are the
    same string to it. Fixing that touches lib/band.ts and its mirror in
    scripts/validate-content.mjs and could shift existing keys.
  - Accounts already deleted still hold a stale app_user_identities row. The fix
    stops new ones accruing; clearing the existing ones is a one-off DELETE against
    production D1 that has not been written or run.
  - Whether the tutor reading speaking transcripts is automatic or opt-in, and
    whether a learner can decline. The privacy paragraph for it is still to be
    placed.

## Was running when the window closed — re-spawn these

  - examiner nudge (design settled, spec in the transcript; fixes up to 55 s of
    dead air after a short answer — the highest-value item on this list)
  - British voices across every surface, and Part 4's speaking rate
  - fifteen defect fixes in the new papers, including reading-24's unscrambled
    matching-headings bank, which is scoreable without reading the passage
  - the tutor reading speaking results, lowest-scoring sitting first
  - UI defect sweep across three widths and three themes

## Still not done

  - Adaptive examiner previews 1, 3 and 4 (the plan is in the session transcript;
    preview 2, the nudge, was being built when the window closed)
  - Transcript grammar analysis on the speaking result
  - The mock exam still uses browser voices rather than Aura
  - Three-surface verification: browser drive, simulator drive, live preview
