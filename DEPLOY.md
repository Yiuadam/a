# Deploying BandUp

**Short version:** it is already set up. Every push to `main` deploys itself to
Cloudflare Workers, at one address that never changes:

```
https://bandup.siksafe-realtime-ai-vision.workers.dev
```

Nothing to run by hand, ever.

## Does the URL change?

No. A Worker has one stable address for its lifetime, and every deployment
replaces what is served there. Bookmark it, put it in the App Store listing,
hand it to a tester — it keeps working. (Cloudflare also keeps every previous
version, which is what makes a rollback possible, but you never have to use
those addresses.)

When `bandup.study` is ready, add it under **Workers & Pages → bandup →
Settings → Domains & Routes → Add custom domain**. That is a DNS change
pointing at the same Worker, not a move: the app, the secrets and the database
all stay exactly where they are. The `.workers.dev` address keeps working
alongside it.

## What makes it deploy

`.github/workflows/deploy-cloudflare.yml`, on every push to `main`. It needs
two repository secrets under **Settings → Secrets and variables → Actions**:

| Secret | Where to get it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → Create Token → *Edit Cloudflare Workers* |
| `CLOUDFLARE_ACCOUNT_ID` | Workers & Pages → Overview, in the right-hand sidebar |

Without them the workflow logs a notice and exits successfully, so it never
turns the build red for a fork or a clone that has no credentials.

If you add the secrets *after* a push, that run has already skipped its deploy
step and there is nothing to re-run. Trigger one from **Actions → Deploy to
Cloudflare → Run workflow**, which is what `workflow_dispatch` is there for.

## What the Worker needs set on it

Repository secrets let CI *deploy* the Worker. They are not what the Worker
*runs with*. Everything the app reads at runtime lives in Cloudflare, set
under **Workers & Pages → bandup → Settings → Variables and Secrets**, each one
with its type set to **Secret**:

| Variable | Needed for |
|---|---|
| `ANTHROPIC_API_KEY` | writing feedback, the speaking examiner, word definitions, test generation |
| `ACCOUNTS_ENABLED` | set to `1` to switch accounts on at all |
| `SUPABASE_URL` | accounts |
| `SUPABASE_ANON_KEY` | accounts |
| `SUPABASE_SERVICE_ROLE_KEY` | accounts |
| `USAGE_IP_HASH_SALT` | per-address rate limiting; without it that limit is skipped rather than done badly |
| `ACCOUNTS_ALLOWED_ORIGINS` | the iOS app; `capacitor://localhost,https://localhost` |

See `.env.example`. A missing `ANTHROPIC_API_KEY` is the common one: the app
loads and every page works, and only the AI features answer with an error.

Changing any of them takes effect on the next deploy, so click **Deploy** after
editing.

## Deploying by hand

Note the order. `preview` and `deploy` both act on an *already built* app and
neither builds one, so `cf:build` comes first or they fail with `Could not find
compiled Open Next config`.

```bash
npm run cf:build     # required before either of the next two
npm run cf:preview   # optional: run it locally first
npm run cf:deploy
```

## Do not add a proxy.ts or a middleware.ts

`npm run cf:build` will fail if you do, and that check exists because it
happened. The pull request that added `proxy.ts` passed every check — lint,
build, tests, the content validator, the placement simulation, the iOS bundle —
and broke Cloudflare deployment completely, with nothing to notice it. Next.js
16 runs `proxy.ts` on the Node.js runtime and **refuses `export const
runtime`** in that file, while OpenNext's Cloudflare adapter rejects Node
middleware:

```
ERROR Node.js middleware is not currently supported.
```

There is no configuration that satisfies both. What such a file would do —
stripping forgeable headers, answering CORS preflights — lives in
`lib/http/cors.ts` and `lib/http/trust.ts` instead, applied per route.

`npm run cf:build` runs in CI on every push, so a change that breaks the Worker
fails before it is merged rather than when someone tries to deploy.

## The iOS app

The mobile bundle points at whatever API you give it at build time:

```bash
NEXT_PUBLIC_API_BASE=https://bandup.siksafe-realtime-ai-vision.workers.dev npm run build:mobile
npx cap sync ios
```

Because the production URL is stable, this only ever needs setting once.

## Vercel

The app ran on Vercel first and no longer does. The workflow and the
configuration are gone from this repository as of the move; `git log` has them
if they are ever wanted back.

Two things to do once, if they have not been done already:

1. **Disconnect the Git integration** — Vercel → the project → Settings → Git →
   Disconnect. Until that happens Vercel keeps building every push and serving
   an increasingly stale copy of the app at its own URL, with none of the
   Cloudflare secrets, which is a confusing thing to leave lying around.
2. **Delete the project**, or keep it as a cold fallback. Nothing depends on
   it. If it is kept, remember it holds its own copy of every secret.

Why the move, in short: Vercel's Hobby plan caps a request at 60 seconds, which
is exactly the ceiling the AI routes are written against, and running two hosts
meant setting every secret twice with no way to notice when the two drifted
apart. The trade accepted in exchange is that Next.js support on Workers comes
through the `@opennextjs/cloudflare` adapter rather than from the framework's
own vendor, so it can lag new Next.js features — which is what the CI build
check is there to catch.
