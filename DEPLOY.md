# Deploying BandUp

**Short version:** connect the repo to a host once. After that every push to
`main` deploys itself to the same URL. Nothing to run by hand, ever again.

Two hosts are wired up and both are supported: **Vercel** (below) and
**Cloudflare Workers** (further down). The Worker build runs in CI on every
push, so neither can quietly rot while the other is in use.

## Does the URL change?

No. Vercel gives the project one **production domain** that is fixed for the
life of the project:

```
https://<project-name>.vercel.app
```

Every production deployment replaces what is served at that address. You can
bookmark it, put it in the App Store listing, hand it to a tester — it keeps
working. (Each individual deployment also gets a unique immutable URL, useful
for rolling back, but you never have to use those.)

Preview deployments — the ones built from a pull request — do get their own
URLs, because the whole point is to look at a change before it goes live.

To use your own domain instead, add it under **Settings → Domains** in Vercel
and point the DNS record it shows you. That address then becomes the permanent
one and never changes either.

## "It keeps asking me to sign in to Vercel"

That is **Deployment Protection**, a Vercel setting, not anything in the app.
By default Vercel puts a login wall in front of *preview* deployments — the
ones built from a pull request — so that unreleased work is not public.
Production is normally open.

Two things follow from that:

- Once a change is merged, use the production URL. Preview links are throwaway
  and protected; there is no reason to keep one after its pull request lands.
- If production itself asks for a login, turn the wall off:
  **Settings → Deployment Protection → Vercel Authentication → Disabled**.

Disabling it makes the site reachable by anyone with the address, which is the
point of a published app. Nothing is exposed by doing so: no learner data is
stored on the server, progress lives in each visitor's own browser, and the
only secret involved is `ANTHROPIC_API_KEY`, which stays server-side and is
never sent to the browser.

## One-time setup (about two minutes)

1. Go to [vercel.com/new](https://vercel.com/new) and import this repository.
2. Vercel detects Next.js — accept the defaults and deploy.
3. Add the API key under **Settings → Environment Variables**:
   `ANTHROPIC_API_KEY`, applied to Production, Preview and Development.
4. Redeploy once so the key is picked up.

That is it. Vercel's Git integration now builds and deploys on every push.

## The GitHub Action

`.github/workflows/deploy.yml` does the same thing from CI instead, for when
you would rather deploy from a workflow than from Vercel's Git integration —
for example if you want the deploy to wait on other jobs.

It is inert until you add three repository secrets under
**Settings → Secrets and variables → Actions**:

| Secret | Where to find it |
|---|---|
| `VERCEL_TOKEN` | Vercel → Account Settings → Tokens → Create |
| `VERCEL_ORG_ID` | `.vercel/project.json` after running `vercel link`, or Vercel → Settings → General |
| `VERCEL_PROJECT_ID` | same place as the org id |

Without them the job logs a notice and exits successfully, so it never turns
the build red for someone who has not set it up.

**Use one or the other.** If Vercel's Git integration is already connected,
you do not need the Action, and running both just deploys the same commit
twice.

## Deploying by hand

```bash
npm i -g vercel
vercel link          # once
vercel --prod        # deploy to the production URL
```

## Cloudflare Workers

The Worker is a first-class target: `npm run cf:build` runs in CI on every
push, so a change that breaks it fails before it is merged rather than when
someone tries to deploy.

That check exists because it happened. The pull request that added `proxy.ts`
passed every check — lint, build, tests, the content validator, the placement
simulation, the iOS bundle — and broke Cloudflare deployment completely, with
nothing to notice it. Next.js 16 runs `proxy.ts` on the Node.js runtime and
**refuses `export const runtime`** in that file, while OpenNext's Cloudflare
adapter rejects Node middleware:

```
ERROR Node.js middleware is not currently supported.
```

There is no configuration that satisfies both, which is why this app has no
`proxy.ts`. What it did — stripping forgeable headers, answering CORS
preflights — now lives in `lib/http/cors.ts` and `lib/http/trust.ts`, applied
per route. **Do not add a `proxy.ts` or a `middleware.ts`.** `npm run cf:build`
will fail if you do.

### One-time setup

1. Create the Worker. Note the order: `preview` and `deploy` both act on an
   *already built* app and neither builds one, so `cf:build` comes first or
   they fail with `Could not find compiled Open Next config`. And the secret
   comes last, because `wrangler secret put` needs a Worker that already
   exists.

   ```bash
   npm run cf:build                        # required before either of the next two
   npm run cf:preview                      # optional: run it locally first
   npm run cf:deploy                       # creates the Worker
   npx wrangler secret put ANTHROPIC_API_KEY
   ```

2. To deploy from CI instead, add two repository secrets under
   **Settings → Secrets and variables → Actions**:

   | Secret | Where to get it |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → Create Token → *Edit Cloudflare Workers* |
   | `CLOUDFLARE_ACCOUNT_ID` | Workers & Pages → Overview, in the right-hand sidebar |

   Without them `.github/workflows/deploy-cloudflare.yml` skips quietly rather
   than failing.

   If you add the secrets *after* a push, that run has already skipped its
   deploy step and there is nothing to re-run. Trigger one from **Actions →
   Deploy to Cloudflare → Run workflow**, which is what `workflow_dispatch` is
   there for.

3. Secrets set with `wrangler secret put` live in Cloudflare, not in the
   repository, and are **not** carried over from Vercel. Everything the app
   needs has to be set again on the Worker: `ANTHROPIC_API_KEY`, and — when
   accounts are switched on — `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, `USAGE_IP_HASH_SALT`, `ACCOUNTS_ENABLED` and
   `ACCOUNTS_ALLOWED_ORIGINS`. See `.env.example`.

The Worker has a stable address (`bandup.<subdomain>.workers.dev`, or a custom
domain), so the same "URL never changes" answer applies — but note that it is a
*different* address from the Vercel one. Moving hosts changes the URL unless a
custom domain is pointed at the new one.

### Running both at once

`deploy.yml` (Vercel) and `deploy-cloudflare.yml` both fire on pushes to
`main`. That overlap is deliberate while the move is in progress: the same
commit is served from both, so the Worker can be exercised for real before
anything is switched off. When the Cloudflare URL is the one people use,
delete `deploy.yml` and disconnect the Vercel Git integration.

## The iOS app

The mobile bundle points at whatever API you give it at build time:

```bash
NEXT_PUBLIC_API_BASE=https://your-production-url npm run build:mobile
npx cap sync ios
```

Because the production URL is stable, this only ever needs setting once.
