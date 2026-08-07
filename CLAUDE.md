@AGENTS.md

# Working agreement

**Ship every change straight to production.** The owner has asked not to be
consulted per change: build what was asked, verify it, push, wait for CI, then
merge to `main` yourself. Vercel deploys `main` automatically, so merging is
what makes a change live.

The flow for each request:

1. Work on the branch `claude/english-exam-prep-app-rbklw7`, restarting it from
   the latest `main` whenever its previous pull request has been merged.
2. Before pushing, run everything CI runs — `npx eslint .`, `npm run build`,
   `node scripts/validate-content.mjs`, `node scripts/simulate-placement.mjs`,
   and `npm run build:mobile` — and exercise the change in a real browser.
   Nothing reaches production that has not been seen working.
3. Push, open a pull request, wait for the checks, merge it.
4. Say plainly what went live, and say so just as plainly if something is
   broken. There is no review step now, so honesty about failures is the only
   safeguard left.

Production is <https://a-nine-peach.vercel.app>. The URL is permanent; every
deployment replaces what is served there.

# House style

- Content — questions, passages, scripts, explanations, glossary entries — is
  written from scratch. Nothing is copied from published material, because this
  app is going to the App Store and plagiarism there is fatal.
- Every question carries an explanation. The content validator fails the build
  without one, and that is deliberate: a mark tells a learner where they are,
  an explanation tells them how to move.
- Explanations are written for someone whose English is the thing being taught.
  Where a grammar term is unavoidable, it belongs in `data/glossary.json` so the
  learner can tap it.
