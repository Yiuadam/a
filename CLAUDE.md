@AGENTS.md

# Working agreement

**Preview every change. Never deploy to production yourself.** BandUp has real
users. The owner reviews each change on its own preview URL and decides when it
goes live; nothing reaches `bandup.life` without that.

This replaces the earlier agreement to merge straight to `main`, which was the
right trade only while a bad deploy could inconvenience nobody but the owner.

The flow for each request:

1. Work on a branch off the latest `main`.
2. Before pushing, run everything CI runs — `npx eslint .`, `npm run build`,
   `npm test`, `node scripts/validate-content.mjs`,
   `node scripts/simulate-placement.mjs`, `npm run build:mobile`,
   `npm run cf:build` and `node scripts/check-delivery.mjs` — and exercise the
   change in a real browser. A preview the owner has to debug is worse than no
   preview.
3. Push and open a pull request. `.github/workflows/preview-cloudflare.yml`
   uploads it as its own Worker version and comments the preview URL.
4. Give the owner the preview link and say what to look at. **Then stop.**
   Do not merge, and do not run the deploy workflow, unless the owner says so
   for that specific change.
5. Say plainly what is in it, and just as plainly if something is broken.

Two things to remember about a preview: it runs against the **real** Supabase
and the real Stripe configuration, because secrets belong to the Worker rather
than to a version — so anything done on a preview happens to real data. And a
database migration is not previewable at all: applying one changes production
immediately, so say so before asking for one.

Production is <https://bandup.siksafe-realtime-ai-vision.workers.dev>. The URL is
permanent; every deployment replaces what is served there. It becomes
`bandup.life`, which it now is — a DNS change rather than a move, so the
workers.dev URL still serves the same deployment.

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
