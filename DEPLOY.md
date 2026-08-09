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

> **Type must be Secret, not Text — including for the ones that are not
> secret.** This is a Cloudflare mechanic and it has bitten this project once
> already. `wrangler deploy` replaces the Worker's bindings with what is in
> `wrangler.jsonc`, so a plain **Text** variable added in the dashboard is
> *deleted by the next deploy*. Encrypted **Secret** values are preserved.
>
> The symptom is the confusing kind: you add the variable, the deploy goes
> green, and the app behaves as though you never added it — because by then you
> hadn't. `ADMIN_USERNAME` is the one most likely to be got wrong, since it
> genuinely holds nothing secret; store it as a Secret anyway, because the
> choice is about surviving a deploy rather than about confidentiality.
>
> If a variable stops working right after a deploy, this is why. Re-add it as a
> Secret and deploy again.

| Variable | Needed for |
|---|---|
| `ANTHROPIC_API_KEY` | writing feedback, the speaking examiner, word definitions, test generation |
| `ACCOUNTS_ENABLED` | set to `1` to switch accounts on at all |
| `SUPABASE_URL` | accounts |
| `SUPABASE_ANON_KEY` | accounts |
| `SUPABASE_SERVICE_ROLE_KEY` | accounts |
| `USAGE_IP_HASH_SALT` | per-address rate limiting; without it that limit is skipped rather than done badly |
| `ACCOUNTS_ALLOWED_ORIGINS` | the iOS app; `capacitor://localhost,https://localhost` |
| `STRIPE_SECRET_KEY` | subscriptions: creating a Checkout Session and a billing portal session |
| `STRIPE_WEBHOOK_SECRET` | subscriptions: verifying that a webhook delivery really came from Stripe |
| `STRIPE_PRICE_PRO_MONTHLY` | the Stripe Price id behind the monthly Pro plan |
| `STRIPE_PRICE_PRO_YEARLY` | the Stripe Price id behind the yearly Pro plan |
| `ADMIN_EMAILS` | your own address, so signing in with it makes you the owner. Comma-separate for more than one |
| `ADMIN_USERNAME` | a name you can type instead of that address at sign-in. Optional |

See `.env.example`. A missing `ANTHROPIC_API_KEY` is the common one: the app
loads and every page works, and only the AI features answer with an error.
Missing Stripe variables are similar and deliberately quiet: `/pricing` still
renders both plans and their prices and says subscriptions are not open yet,
rather than showing a button that fails.

Changing any of them takes effect on the next deploy, so click **Deploy** after
editing.

## Signing in as the owner

Three ways in, and they land on the same account. Which you use is a matter of
taste; what makes it the *owner's* account is `ADMIN_EMAILS`, not the door.

**With Google or Apple.** Sign in as normal with the address in `ADMIN_EMAILS`.
Nothing else to do — `lib/billing/entitlements.ts` checks that variable before
it reads the database, so the very first sign-in is already an owner's.

**With a password.** Give the account one, from a shell that has the
deployment's variables:

```
SUPABASE_URL=https://xxxx.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=eyJ... \
node scripts/set-admin-password.mjs --email you@example.com --password 'a long passphrase'
```

If the address has no account yet, that creates one and marks it confirmed. The
password is never stored in this repository and the script prints neither it nor
the key.

*Without a terminal*, the Supabase dashboard does the same thing and no SQL is
involved: **Authentication → Users**. If the address is already listed, open the
row's `⋯` menu and choose **Reset password** (or **Edit user**, depending on
your dashboard version) and type the new one. If it is not listed, **Add user →
Create new user**, enter the address and the password, and tick **Auto Confirm
User** — without that tick the account exists but cannot sign in until it
confirms by email.

**With a username.** Set `ADMIN_USERNAME` to whatever you would rather type —
it resolves to the first address in `ADMIN_EMAILS` on the server, before the
password is checked. It is a convenience and not a secret, and there is no
separate username account: it is the same row in Supabase either way.

One thing worth saying plainly, because it is the weakest link in the whole
deployment: the owner's account can change prices and read every learner's
usage. `/api/auth/password` limits failed attempts per address per isolate, and
Supabase applies its own limits on top, but a short numeric password is still a
short numeric password. A passphrase costs a few seconds a week.

## Turning subscriptions on

Four things, in this order. Nothing before the last step changes what a visitor
sees.

**1. Create the product and its two prices.** Stripe dashboard → Product
catalogue → Add product. One product, "BandUp Pro", with two recurring prices:
`$9.00` monthly and `$72.00` yearly. The amounts have to match what `/pricing`
shows, which lives in `lib/billing/tiers.ts` — Stripe is what actually charges,
and the page is only copy, so a mismatch charges the amount the page did not
say. Copy each `price_…` id into `STRIPE_PRICE_PRO_MONTHLY` and
`STRIPE_PRICE_PRO_YEARLY`.

**2. Add the webhook endpoint.** Developers → Webhooks → Add endpoint, pointing
at:

```
https://bandup.siksafe-realtime-ai-vision.workers.dev/api/billing/webhook/stripe
```

Subscribe it to exactly three events, and no others:

- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Between them they carry the whole lifecycle — the first fires the moment
checkout completes, the second on every renewal, plan change, failed payment
and cancellation. `checkout.session.completed` is deliberately not needed:
it arrives with no period end, and the account id it carries is also stamped
onto the subscription itself, where every later event carries it too. Anything
else that is subscribed is acknowledged and ignored, which shows up in the
Worker log as noise.

Copy the signing secret into `STRIPE_WEBHOOK_SECRET`. If it is ever rotated,
update it here in the same minute: in between, every delivery fails its
signature check and no payment is recorded, and nothing about the app looks
broken while that is happening.

**3. Set the four variables on the Worker**, as **Secret**, and deploy.

**4. Check it with a real payment.** Stripe's test mode is the right place to
start — a test-mode key and a test-mode endpoint work exactly the same way —
but the thing worth doing at least once in live mode is buying a subscription
with a real card and cancelling it. What that proves, which nothing else does:
that the webhook reaches the Worker at all (Cloudflare, DNS, the route), that
the signature verifies against the secret as it was actually pasted, and that
the row lands with the right account on it.

**Enable the customer portal** while you are there — Settings → Billing →
Customer portal — with cancellation allowed. `/pricing` sends a subscriber
there to cancel, and cancelling has to be at least as easy as subscribing.

### On iOS this will not be Stripe

Apple requires in-app purchase for digital goods, so the App Store build cannot
sell through the checkout above. That work is not done. The database is ready
for it — `subscriptions.provider` already accepts `apple`, and the entitlement
resolver does not care which provider granted a tier — but the StoreKit side,
the receipt verification and App Store Server Notifications v2 all still have
to be built, and all of them need the Mac that everything else in APPSTORE.md
is waiting on. Until then, `/pricing` says so, and subscribing is a web
feature.

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
