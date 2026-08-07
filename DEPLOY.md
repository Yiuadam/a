# Deploying BandUp

**Short version:** connect the repo to Vercel once. After that every push to
`main` deploys itself to the same URL, and every pull request gets its own
preview URL. Nothing to run by hand, ever again.

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

## Cloudflare Workers instead

The Worker build is wired up as well:

```bash
npm run cf:preview                      # run it locally first
npx wrangler secret put ANTHROPIC_API_KEY
npm run cf:deploy
```

The Worker also has a stable address (`bandup.<subdomain>.workers.dev`, or a
custom domain), so the same "URL never changes" answer applies. See the
comparison table in the README for which to pick.

## The iOS app

The mobile bundle points at whatever API you give it at build time:

```bash
NEXT_PUBLIC_API_BASE=https://your-production-url npm run build:mobile
npx cap sync ios
```

Because the production URL is stable, this only ever needs setting once.
