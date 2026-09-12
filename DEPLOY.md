# Deploying BandUp

**Short version:** it is already set up. Every push to `main` deploys itself to
Cloudflare Workers, at one address that never changes:

```
https://bandup.life
```

Nothing to run by hand, ever.

## Google sign-in in the iOS app

The app signs in with Google through the system's OAuth sheet
(`ios/App/App/GoogleSignInPlugin.swift`), not through the website's button —
Capacitor hands a navigation off the app's own origin to Safari, which is why
the old version signed people in somewhere the app could not read.

It needs an **iOS OAuth client**, which is a different registration from the
website's and has no client secret at all: Google does not issue one for an
installed application, because a secret shipped inside an app is not a secret.
Three steps, and they have to be done together — the app draws no Google button
until the first two are in place, so a half-done setup shows Apple and email
rather than a button that fails:

1. **Google Cloud console → Credentials → Create credentials → OAuth client ID
   → iOS.** Bundle ID `com.yiuadam.bandup`. Copy the client ID.
2. **Set `GOOGLE_IOS_CLIENT_ID` on the Worker** to that value
   (`npx wrangler secret put GOOGLE_IOS_CLIENT_ID`, or the dashboard). It is not
   secret, but it lives with the other auth configuration.
3. **Paste the reversed client ID into `ios/App/App/Info.plist`**, replacing
   `com.googleusercontent.apps.REPLACE-WITH-IOS-CLIENT-ID`. Reversed means the
   dot-separated parts in the opposite order, which is the redirect scheme
   Google requires and the one the plugin builds for itself at run time.

Nothing about the server routes changes. The sheet returns a signed Google ID
token, which is the same thing the website's button produces, and
`/api/auth/google/token` accepts either of the two clients by audience.

**One thing to settle before submitting.** Offering any third-party login puts
the app under App Review guideline 4.8, which wants an equivalent way in that
lets somebody keep their email address private — and that is Sign in with Apple,
which is written but returns `enabled: false` because it has no server
configuration yet. Either finish Apple's setup or leave `GOOGLE_IOS_CLIENT_ID`
unset until you do; with neither third-party login offered the app falls under
4.8's own exception for an app that uses only the developer's account system.

## Does the URL change?

No. A Worker has one stable address for its lifetime, and every deployment
replaces what is served there. Bookmark it, put it in the App Store listing,
hand it to a tester — it keeps working. (Cloudflare also keeps every previous
version, which is what makes a rollback possible, but you never have to use
those addresses.)

The custom domain `bandup.life` is live. To add another, use **Workers & Pages → bandup →
Settings → Domains & Routes → Add custom domain**. That is a DNS change
pointing at the same Worker, not a move: the app, the secrets and the database
all stay exactly where they are. The `.workers.dev` address keeps working
alongside it.

## What makes it deploy

`.github/workflows/deploy-cloudflare.yml`, when a human asks for it —
**Actions → Deploy to Cloudflare → Run workflow**. Pushing to `main` no longer
deploys on its own: there are real users, so a change goes live when the owner
has looked at its preview and said so.

It needs two repository secrets under **Settings → Secrets and variables →
Actions**:

| Secret | Where to get it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → Create Token → *Edit Cloudflare Workers* |
| `CLOUDFLARE_ACCOUNT_ID` | Workers & Pages → Overview, in the right-hand sidebar |

Without them the workflow logs a notice and exits successfully, so it never
turns the build red for a fork or a clone that has no credentials.

If you add the secrets *after* a push, that run has already skipped its deploy
step and there is nothing to re-run. Trigger one from **Actions → Deploy to
Cloudflare → Run workflow**, which is what `workflow_dispatch` is there for.

### Closing the site from the admin console

The **Run workflow** button takes a *Close the site* checkbox, and that is the
only mechanism that has ever actually closed the site. It sets
`NEXT_PUBLIC_MAINTENANCE_MODE` for the build, which is the one prefix Next
substitutes into the compiled code; anything read at runtime is read on the
Cloudflare Worker, where it is not there. That has now been learned twice —
once from a plain `process.env` lookup that left the site open through three
deploys reporting success, and once from a database read in the root layout
that answered 500 on every page of a preview.

So the console's site switch (**/admin → Site status**) does not try to close
the site itself. It records the decision and then starts this workflow with the
box ticked, which takes about two minutes. To let it, give the Worker one more
secret:

| Secret | What it is |
|---|---|
| `GITHUB_DEPLOY_TOKEN` | A **fine-grained** personal access token, this repository only, with **Actions: Read and write**. Nothing else. |

Make it at **github.com/settings/personal-access-tokens** → Generate new token
→ Only select repositories → this one → Repository permissions → Actions →
**Read and write**, and **Contents → Read-only** so it can resolve the branch
to build. Nothing else.

The permission is the part that goes wrong: Actions defaults to *Read*, which
looks right in the list and is refused with a 403 that says nothing about which
permission was missing. The console names this cause first when GitHub refuses
the token, because it is the one it almost always is.

Then put it on the Worker, not in the repository:

```bash
npx wrangler secret put GITHUB_DEPLOY_TOKEN
```

Set an expiry you will notice — when it lapses the switch says so rather than
failing quietly, and the workflow still runs by hand.

**If that command fails with "the latest version of your Worker isn't currently
deployed"** (Cloudflare error 10215), nothing is wrong with the token or the
account. Every pull request preview runs `wrangler versions upload`, which
leaves an uploaded-but-undeployed version as the latest one, and wrangler
refuses a plain `secret put` in case you were about to deploy it by accident.
Use the command made for that case instead:

```bash
npx wrangler versions secret put GITHUB_DEPLOY_TOKEN
```

It stores the secret without deploying anything. This will happen every time
there is an open preview, which is most of the time, so reach for
`versions secret put` first and keep `secret put` for a quiet repository.

> **Read the next paragraph before you deploy that version.** "Without
> deploying anything" is the whole point and also the whole trap. The new
> version is built on top of the *latest* version, and with a preview open the
> latest version is the preview — someone else's branch, or your own
> unfinished one. So the version now sitting at the top of the list is that
> branch's code plus your secret, and deploying it to "turn the secret on"
> ships the branch with it. The dashboard's own **Variables and Secrets** page
> stages a version the same way and reads even more innocently.
>
> This is not hypothetical: adding `GOOGLE_OAUTH_CLIENT_SECRET` on 2 September
> produced exactly such a version, with a hundred commits of an open branch
> behind it, while production still served code from 30 August.
>
> A secret only becomes live when a version carrying it is deployed. So there
> are two honest choices, and no third:
>
> - **Wait.** Leave it staged; it activates on the next real deploy. Correct
>   whenever the branch is going out soon anyway.
> - **Deploy the code that is already live.** From a clean `main` checkout,
>   build and deploy. That rebuilds what production is already serving and
>   picks the secret up with it, so nothing changes except the thing the
>   secret switches on.
>
> What you must not do is deploy the staged version because its message says
> "Add secret". The message describes the binding, not the code.

**The same applies to uploading several at once**, which is the form you will
actually hit, because `scripts/stripe-setup.mjs --out` tells you to run
`wrangler secret bulk`. With a preview open that is refused with the same
10215. The bulk command has the same versions variant:

```bash
npx wrangler versions secret bulk stripe-prices.env
```

One thing to understand about both: they create a new *version* carrying the
new values and deploy nothing, so the running site is unchanged until a version
containing them is deployed. That is usually what you want — set the secrets,
then deploy — but it does mean a secret can sit uploaded and inert, which looks
identical to a secret that was never set. If a value appears not to have taken
effect, check whether anything has been deployed since you set it.

One thing to know before you use it: the workflow builds from `main`, so
throwing the switch ships whatever is on `main` at that moment — closing the
site also deploys anything merged since the last deploy. GitHub's dispatch API
takes a branch rather than a commit, so there is no way to redeploy exactly
what is already live. The console says this on the switch.

Without the token the switch still records what you asked for and the console
says plainly that nothing was deployed, naming the workflow to run yourself.
That is the honest degradation: no button that appears to work and does not.

A fork does not need any of this. Nothing about a token being absent breaks a
build, a test or a page.

## What the Worker needs set on it

Repository secrets let CI *deploy* the Worker. They are not what the Worker
*runs with*. Everything the app reads at runtime lives in Cloudflare, set
under **Workers & Pages → bandup → Settings → Variables and Secrets**.

Use **Secret** for anything that is actually secret — a key, a token, a salt —
because Secrets are encrypted at rest and hidden from the dashboard once saved.
**Text** is fine for the rest. Either type survives a deploy.

> **This used to be a trap, and it cost two outages.** Wrangler's default is to
> treat `wrangler.jsonc` as the only source of truth for variables: every
> deploy deleted the Worker's plain-text variables and then set whatever `vars`
> said. There is no `vars` block, so it deleted and set nothing back. Secrets
> survived, which made it look random rather than systematic.
>
> The first time it took `ADMIN_USERNAME`. The second time it took
> `ADMIN_USERNAME`, `ACCOUNTS_ENABLED` and all six `STRIPE_PRICE_*` together —
> locking the owner out of admin and closing subscriptions on a live site, on a
> deploy that reported success.
>
> `wrangler.jsonc` now sets `keep_vars: true`, so deploys leave variables
> alone, and `tests/deploy-config.test.mjs` fails if that line is removed. The
> old advice here — "mark everything Secret even when it holds nothing secret"
> — is no longer needed.

| Variable | Needed for |
|---|---|
| `ANTHROPIC_API_KEY` | writing feedback, the speaking examiner, word definitions, test generation |
| `ANTHROPIC_ADMIN_KEY` | exact historical Anthropic costs in the owner finance dashboard. Separate read-only Admin API key; optional |
| `ANTHROPIC_WORKSPACE_ID` | limits owner finance costs to BandUp's Anthropic workspace; optional |
| `ACCOUNTS_ENABLED` | set to `1` to switch accounts on at all |
| `SUPABASE_URL` | accounts |
| `SUPABASE_ANON_KEY` | accounts |
| `SUPABASE_SERVICE_ROLE_KEY` | accounts |
| `AVATAR_URL_SIGNING_KEY` | private R2 avatar delivery once learner reads move to Cloudflare (`CLOUDFLARE_DATA_MODE=read_cloudflare` or `cloudflare` — the code gates on *reading*, not on write authority); generate with `openssl rand -hex 32` and store as a Secret |
| `USAGE_IP_HASH_SALT` | per-address rate limiting; without it that limit is skipped rather than done badly |
| `ACCOUNTS_ALLOWED_ORIGINS` | the iOS app; `capacitor://localhost,https://localhost` |
| `GOOGLE_OAUTH_CLIENT_SECRET` | The redirect half of Google sign-in, which is now the **website's fallback and nothing else**: when Google's own script cannot load in a browser, the button becomes a link to `/api/auth/google/start`, and that route needs this. It was originally added for the iOS app, which no longer offers Google at all — see the 4.8 note in `APPSTORE.md` — so a missing value can no longer be seen from a phone. Store as a Secret. Without it `/api/auth/google/config` answers `serverFlow: false` and that fallback draws "Google sign-in is being updated. Please try again shortly." instead of a link, while the ordinary in-page button carries on working — a failure that stays hidden until somebody's browser blocks Google's script. `GOOGLE_OAUTH_APP_ORIGIN` is already set in `wrangler.jsonc`; this is the half that cannot live there. Confirm with `curl -s https://bandup.life/api/auth/google/config`, which should say `"serverFlow":true` |
| `APPLE_SIGNIN_SERVICES_ID` | Sign in with Apple, web half. The identifier of a **Services ID** (Certificates, Identifiers & Profiles → Identifiers → Services IDs), configured with the domain `bandup.life` and the return URL `https://bandup.life/api/auth/apple/callback`. Not the app's bundle id — that is the native client and is compiled in |
| `APPLE_SIGNIN_TEAM_ID` | Sign in with Apple. The ten-character team identifier from the top right of developer.apple.com |
| `APPLE_SIGNIN_KEY_ID` | Sign in with Apple. The id of a key created under Keys with the Sign in with Apple capability ticked |
| `APPLE_SIGNIN_PRIVATE_KEY` | Sign in with Apple. The whole `AuthKey_XXXXXXXXXX.p8` file including its BEGIN and END lines; it downloads once and Apple will not reissue it. **These four are not the `APPLE_IAP_*` key above** — that one is an App Store Connect key for in-app purchase, and crossing them produces a client secret Apple rejects without saying why. All four need a paid Apple Developer Program membership; until then no Apple button is offered anywhere and `/api/auth/apple/*` answers 404, which is a working state rather than a broken one. D1 migration `0022_apple_identity.sql` must also be applied — read its header first, it rebuilds a live identity table. Confirm with `curl -s https://bandup.life/api/auth/apple/config`, which should say `"enabled":true`, and with the "Sign in with Apple" row on the owner diagnostics panel |
| `STRIPE_SECRET_KEY` | subscriptions: creating a Checkout Session and a billing portal session |
| `STRIPE_WEBHOOK_SECRET` | subscriptions: verifying that a webhook delivery really came from Stripe |
| `STRIPE_PRICE_TRACKING_MONTHLY` | the Stripe Price id behind Tracking, monthly |
| `STRIPE_PRICE_TRACKING_YEARLY` | the Stripe Price id behind Tracking, yearly |
| `STRIPE_PRICE_AI_MONTHLY` | the Stripe Price id behind AI, monthly |
| `STRIPE_PRICE_AI_YEARLY` | the Stripe Price id behind AI, yearly |
| `ADMIN_EMAILS` | your own address, so signing in with it makes you the owner. Comma-separate for more than one |
| `ADMIN_USERNAME` | a name you can type instead of that address at sign-in. Optional |

See `.env.example`. A missing `ANTHROPIC_API_KEY` is the common one: the app
loads and every page works, and only the AI features answer with an error.
Missing Stripe variables are similar and deliberately quiet: `/pricing` still
renders every plan and its price and says subscriptions are not open yet,
rather than showing a button that fails. A plan whose Price id is missing is
simply not offered, so it is fine to set Tracking up first and add AI
later.

Changing any of them takes effect on the next deploy, so click **Deploy** after
editing.

Before `CLOUDFLARE_DATA_MODE` is set to `read_cloudflare` **or** `cloudflare` —
not only the final one-way step — set `AVATAR_URL_SIGNING_KEY` to an
independent random value of at least 32 characters. `readsFromCloudflare()`,
which decides whether the profile route asks D1 for an avatar grant instead of
Supabase, is true under `read_cloudflare` as well as `cloudflare`; a version of
this document that said otherwise once left the key unset through a real
`read_cloudflare` deploy, and every learner with a photo lost their whole
account page, not only the photo, until app/api/account/profile/route.ts was
changed to degrade instead of throw. Profile pictures stay in the private
`BANDUP_FILES` R2 binding. The profile API returns a one-hour HMAC grant for
an exact object and the Worker streams it only while D1 still points at that
object; no `r2.dev` or public-bucket access is used. Rotating the key
invalidates outstanding avatar URLs, which recover on the next profile read.

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

**1. Create the products and prices — with the script, not by hand.**

There are four prices and each carries nine other currencies, which is forty
amounts to type correctly into a dashboard. Don't. `scripts/stripe-setup.mjs`
creates all of it from `lib/billing/tiers.ts`, which is the same catalogue the
pricing page prints and the checkout guard checks against, so the three cannot
disagree:

```
STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-setup.mjs --dry-run   # look first
STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-setup.mjs             # then do it
```

It is idempotent — a Price that is already correct in every currency is left
alone — and it prints the four `price_…` ids.

Add `--out stripe-prices.env` and it writes them in the shape Wrangler reads,
so the four never have to be retyped:

```
STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-setup.mjs --out stripe-prices.env
npx wrangler secret bulk stripe-prices.env
rm stripe-prices.env
```

Four ids pasted into four dashboard fields is four chances to put AI's id in
Tracking's slot, which sells the expensive plan at the cheap price. The
checkout guard refuses that sale rather than charging wrongly, so it is
survivable — but not making the mistake is better than catching it.

The base prices, for reference. Neither plan sells the practice library
itself — every reading, listening, writing and speaking paper is free the
moment somebody signs in. Tracking sells a saved, synced history; AI adds
marking, a tutor and word lookup on top of Tracking:

| Product | Monthly | Yearly | Variables |
|---|---|---|---|
| BandUp Tracking | `HK$4.90` | `HK$39` | `STRIPE_PRICE_TRACKING_MONTHLY`, `STRIPE_PRICE_TRACKING_YEARLY` |
| BandUp AI | `HK$8.90` | `HK$89` | `STRIPE_PRICE_AI_MONTHLY`, `STRIPE_PRICE_AI_YEARLY` |

Each Price also carries USD, EUR, GBP, AUD, CAD, SGD, JPY, INR and CNY as
`currency_options`, so one Price id charges a Londoner in pounds and a Tokyo
candidate in yen. Checkout picks by the customer's address; the pricing page
picks by the same address, so what a reader is shown is what their card is
charged. Any country not in that list is converted by Stripe from the base
price.

**Adding a currency later** is the same command and no new ids. Put the amounts
in `prices` in `lib/billing/tiers.ts`, then:

```
STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-setup.mjs --dry-run
STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-setup.mjs
```

Each existing Price is amended in place — same `price_…` id, same subscribers,
nothing to re-upload to Cloudflare. Only a change to a *base* amount creates a
new Price, because `unit_amount` is the one field Stripe will not let anything
edit.

Run it **before** deploying the code, not after. The checkout guard refuses a
sale whenever the catalogue names a currency the Stripe Price is missing, so a
deploy that lands first takes every checkout down until the command catches up.
`tests/stripe-currency-amendment.test.mjs` holds the amend-in-place behaviour.

Two things the amounts must clear, both enforced by `tests/currency.test.mjs`:
Stripe refuses a charge under about US$0.50, and every price has to cover what
that subscriber costs to serve. There is no purchasing-power discount on the AI
tiers — the model bill is the same wherever somebody lives, and it is already
80-95% of the price.

These are not arbitrary numbers, and they have very little room in them. AI is
cost-plus: what the tier can be made to cost at full usage — every AI request
at its ceiling — plus Stripe's 2.9% + 30c, plus a margin of at least HK$1 a
month, rounded up to a price that looks like a price. Tracking costs nothing
to serve, so its price only has to clear Stripe's own minimum charge.
`tests/ai-economics.test.mjs` fails the build if AI drops below that floor.

Two consequences worth knowing before you set them. On Tracking, Stripe's
fixed 30c is a meaningful share of the charge, so a real portion of what a
Tracking subscriber pays goes to the card network. And HK$1 a month per AI
subscriber does not cover Supabase, Cloudflare or the Apple developer
programme — what makes the plan work is that nobody uses their whole
allowance, so a real month costs a fraction of the ceiling. The floor
guarantees there is never a loss; it is not the business case.

**2. Add the webhook endpoint.** Developers → Webhooks → Add endpoint, pointing
at:

```
https://bandup.life/api/billing/webhook/stripe
```

Subscribe it to these events:

- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `charge.refunded`
- `refund.updated`

The subscription events carry renewable card billing. Checkout completion
grants a one-time Alipay or WeChat Pay pass only after Stripe reports it paid.
The two refund events cover both ordinary full refunds and WeChat Pay's
asynchronous refund completion. Anything else is acknowledged and ignored.

In Stripe → Settings → Payment methods, enable **Alipay** and **WeChat Pay** in
the same live/test mode as the secret key. WeChat Pay availability can require
Stripe approval. Wait until both say **Enabled**, then set
`STRIPE_WALLET_PAYMENTS_ENABLED=1`. Leave it unset while Stripe says **Pending
approval**; BandUp keeps the wallet link hidden instead of sending customers to a
failed checkout, and the card subscription — which is the default path on
`/pricing` anyway — goes on working either way. Wallet checkout is deliberately
prepaid: monthly means one payment for one month and yearly means one payment for
one year; neither renews automatically, and the date a pass ends is shown on the
buyer's own billing page from the moment the webhook lands.

Copy the signing secret into `STRIPE_WEBHOOK_SECRET`. If it is ever rotated,
update it here in the same minute: in between, every delivery fails its
signature check and no payment is recorded, and nothing about the app looks
broken while that is happening.

**3. Set the Stripe variables on the Worker**, as **Secret**, and deploy.

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

### Pausing subscriptions

Selling can be paused without anything about the setup above being undone.
Set `BILLING_CLOSED` to `"1"` in `wrangler.jsonc`'s `vars` block and deploy.
While it reads `"1"`:

- `/pricing` shows a distinct sentence for every paid plan —
  `BILLING_MESSAGES.billingClosed` — rather than the one it shows when Stripe
  was simply never configured. The two are not the same fact, and telling
  them apart is the entire point of the switch.
- `/api/billing/checkout` and `/api/billing/wallet-checkout` refuse with a 503
  and that same sentence before either does any Stripe work, so the page
  hiding the button is backed by the server actually refusing the request.
- `/api/billing/health` reports `billing_closed_by_owner: true` in place of
  the two Price-id checks, and stays `ok: true` — a shop that is closed on
  purpose is not a shop that is broken, and the hourly watch and the
  post-deploy check should not go red for a decision the owner made.
- `/api/billing/portal` and the Stripe webhook are untouched by this switch:
  neither route asks whether new sales are open, so BILLING_CLOSED changes
  nothing about what either does.

  The portal asks only for the Stripe secret key, never for a Price id, so
  removing every `STRIPE_PRICE_*` secret closes new sales without taking
  "Manage billing" away from the people who already pay.

This is a plain `vars` entry rather than a Secret, like `ACCOUNTS_ENABLED` —
flipping it is a deliberate deploy the owner reviews on its own preview, not a
value that should be editable by hand in the dashboard between deploys. See
`billingClosed()` in `lib/billing/env.ts`.

**To reopen:** set `BILLING_CLOSED` to `"0"` (or remove it), re-add the four
`STRIPE_PRICE_*` secrets and `STRIPE_WALLET_PAYMENTS_ENABLED`, and deploy.

## Running on the Workers Free plan

The account is staying on the Workers Free plan. This section is what that
costs, what the code already does about it, the one step still outstanding,
and what to watch once a change goes live.

### What Free gives, and what it does not

**CPU.** 10 ms per invocation, and no way to raise it — Free refuses an
explicit `limits.cpu_ms` outright (error 100328). Cloudflare's own
documentation describes some built-in flexibility for a request that goes
over occasionally rather than as a matter of course, and Error 1102 for one
that keeps doing it. Measured on this branch's preview: 200-plus page
requests and 22 password sign-ins, each carrying roughly 50 ms of bcrypt CPU,
were all served, and none were killed.

**Subrequests.** 50 external `fetch` calls plus 1,000 calls to Cloudflare's
own services (D1, R2) per invocation, per the Workers limits page and its
2026-02-11 changelog entry — though D1's own limits page still quotes 50, so
the replica drain below was budgeted against the stricter number rather than
argue with the discrepancy.

**Requests.** 100,000 a day. Static assets do not count against it, and the
site serves around 1,900 requests a day, so this is not close to binding.

**Email Sending.** A Workers Paid feature outright. On Free, the
`send_email` binding can only reach addresses the owner has verified in
their own Cloudflare account — no use for a learner's inbox.

**Workers AI.** 10,000 Neurons a day, with no overage: a call past it throws
rather than queues. That is roughly 7,300 characters of `aura-1` speech.

**Cron Triggers and the Rate Limiting binding both work on Free.** The
five-minute drain has been running throughout and writing its R2 marker, and
the audio-generation limiter answered `/api/speech-model` with 206, not 503,
on the preview.

**Script size** is not a limit worth worrying about here: the built Worker is
2.27 MiB gzipped.

### What the code does about it

`wrangler.jsonc` reflects the CPU point above by no longer setting
`limits.cpu_ms` at all — see the comment in that file for the fuller
explanation. Four other changes actually adapt the app's behaviour to the
plan:

`lib/email/sender.ts` gives the two native-account emails (registration and
recovery) a second way to send: a Resend transactional call over `fetch`,
chosen whenever `RESEND_API_KEY` is set. The Cloudflare `send_email` binding
remains the other provider, so a Paid account keeps working unchanged with
the key unset.

`open-next.config.ts` turns on the static-assets incremental cache and cache
interception, so a prerendered page is answered from `ASSETS` before the Next
server is even loaded — 52 routes, none of which used to be served that way.
`cf:build` now runs `populateCache` immediately after the build, because the
cache files never reached `.open-next/assets` on their own; with both in
place, those pages come back with an `x-opennext-cache: HIT` header proving
it.

`lib/cloudflare/scheduled-replica-drain.ts`, together with
`lib/cloudflare/replica-outbox.ts`, sizes the five-minute drain tick to fit
inside 50 subrequests rather than the 1,000 it used to assume: one outbox
row, three cleanup keys and one nested cleanup key per tick, a worst case of
38. See that file's own comment for the arithmetic behind each number.

`lib/examiner-audio.ts` caches the live examiner's Part 3 reaction line in R2
the same way the three scripted audio routes already cache theirs, keyed on
the model, the voice and the words. `app/api/speaking/examiner-line/route.ts`
answers 503 with one structured log line reading `examiner tts unavailable`
when the Workers AI call itself fails — the daily Neuron ceiling, most
likely — and the client already treats any non-2xx from that route as
"unavailable" and drops to the device voice.

### Setting up Resend

The one step still outstanding, and the owner's to do. Until it is done,
password sign-up answers 503 and a recovery request silently sends nothing;
Google sign-in is unaffected either way.

1. Create a Resend account.
2. Add `bandup.life` as a sending domain, and add the DKIM, SPF and DMARC
   records Resend gives you for it — the zone is on Cloudflare DNS.
3. Create an API key with sending permission.
4. Store it on the Worker: `npx wrangler versions secret put RESEND_API_KEY`.
   This is the `versions secret` form rather than plain `secret put` —
   see **What makes it deploy** above for why a preview being the newest
   version makes plain `secret put` refuse with error 10215, and for what it
   takes to actually activate a secret staged this way.
5. Verify it: sign up with a password on the preview and confirm the
   confirmation email arrives, then ask for a password recovery and confirm
   that arrives too.

### What to watch

- **Workers Logs**, filtered to `examiner tts unavailable` — the day's
  Neuron ceiling is spent, and learners hear the device voice instead of the
  live examiner until it resets at midnight UTC.
- **Observability**, filtered to outcome `exceededCpu` — this is what a 1102
  looks like from the dashboard rather than from a learner's report.
- **`/api/replica/health`** — already green, and worth an occasional glance
  rather than trusting only the hourly check that already watches it.
- **The daily request count**, against the 100,000 ceiling. Static assets are
  free, so this is really a count of API and dynamic-page traffic.

### Known limits on Free

- A handful of admin tools can, under a strict reading that counts D1 and R2
  operations as subrequests, exceed 50 in one call. Run them accordingly:
  `/api/admin/cloudflare/backfill` with `applyLimit` kept at 10 or below;
  `/api/admin/cloudflare/entitlement-parity` paged with a smaller `limit`
  (it costs about two subrequests per account examined, which is roughly 72
  for today's ~35 users at the default page size); `/api/admin/cloudflare/readiness`
  called with `payloadParity=all` or `avatarObjectParity` only alongside a
  small `payloadParityRows`/`avatarParityRows`/`avatarParityBytes`; and the
  manual drain, `POST /api/admin/cloudflare/replica-outbox`, with `limit` at
  2 or below.
- Ordinary learner traffic stays well inside 50 on the same strict reading,
  with one near-miss: `PUT /api/account/progress` for a Tracking or AI
  subscriber with several reviewed sittings can reach about 51. The overflow
  sits inside `after()`, so the learner still gets their 200 and the
  organisation-ledger chores it triggers simply retry on the next call.
- A latent bug, unrelated to the plan but worth listing here because it is
  also a D1 limit: `feedbackForAttempts` and `studentsFor` in
  `lib/cloudflare/organizations.ts` (around lines 498–506 and 572–581) each
  bind one id per stored attempt or per student into a single query, and D1
  caps bound parameters at 100. A student with 99 or more stored attempts, or
  a class of 99 or more students, would 500. Not yet fixed.
- A backlog much larger than anything seen so far drains slowly by design:
  12 outbox rows an hour. See `lib/cloudflare/scheduled-replica-drain.ts` for
  why that trade was made deliberately rather than sized for a bigger one.
- Moving back to Workers Paid is two edits: restore `"limits": { "cpu_ms":
  30000 }` in `wrangler.jsonc` and its test in `tests/deploy-config.test.mjs`,
  and — optionally, since the Cloudflare binding still works once Paid lifts
  the address restriction — remove `RESEND_API_KEY`.

## Cutting over to Tracking and AI

The three retired tier names — `standard`, `plus`, `pro` — are being replaced by
two: `tracking` (the old Standard price; history and sync) and `ai` (marking,
tutor, lookup, and everything Tracking has). The mapping is fixed:
`standard` → `tracking`, `plus` and `pro` → `ai`. This section is the order to
do it in on the real Cloudflare account and the real Stripe account — nothing
here is previewable, because a preview runs against the same D1 database and
the same Stripe keys as production (see the note at the top of this file). Do
not skip a step or reorder one; each explains why below it.

**1. Pre-flight, read-only. [anyone with wrangler]**

```bash
npx wrangler d1 execute BANDUP_DB --remote --command "SELECT tier, provider, status, COUNT(*) FROM subscriptions GROUP BY 1,2,3"
```

As of today this returns three rows, all `tier='pro'`, `status='active'`: two
`provider='promo'` (free trials) and one `provider='stripe'` — a real Pro
**yearly** subscription, `price_1U2wIuIQuaS8SvAv6TzamEh6`, renewing
2027-08-11. Seeing `pro`, `plus`, or `standard` rows here is expected, not a
problem — step 6 renames them, and until then the running code (old or new)
already knows how to treat them, so nothing breaks in between.

Also check the Stripe dashboard: **Products → BandUp Standard / BandUp Plus /
BandUp Pro → each Price → active subscriptions**. The one to expect is that
same Pro yearly subscription. The new code will map it to AI on its very next
webhook event (a renewal, a card update, anything that fires
`customer.subscription.updated`) — decide now whether to leave it, cancel it,
or refund it if it turns out to be your own test subscription, because once
the new code is live that decision is effectively made for you.

**2. Mint the Tracking and AI prices. [owner — needs the Stripe live key]**

From the repo root, **with this branch checked out** — the script builds
whatever `lib/billing/tiers.ts` defines on the branch you're standing on, and
on `main` today that is still the old Standard/Plus/Pro catalogue:

```bash
STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-setup.mjs --out stripe-prices.env
```

The key is typed into your own shell and goes nowhere else — the script only
ever sends it to `api.stripe.com`. `stripe-prices.env` is not committed
(`.gitignore` in this repo does not currently list it by name, so double-check
`git status` shows it untracked, and delete it once step 3 is done regardless).

Re-running this command is safe — a Price already correct in every currency is
left alone — with one timing caveat: Stripe's product search lags a few
seconds after a product is first created, so if you run it twice, wait at
least a minute between runs or the second run may not find what the first one
just made and try to create it again.

**3. Upload the four secrets. [anyone with wrangler]**

```bash
npx wrangler versions secret bulk stripe-prices.env
rm stripe-prices.env
```

Plain `wrangler secret bulk` (and `secret put`) is refused with Cloudflare
error 10215 whenever the newest uploaded version is undeployed — which is the
normal state here, since every PR preview leaves exactly such a version behind.
`versions secret bulk` sidesteps that: it creates a new, still-undeployed
version carrying the four new `STRIPE_PRICE_TRACKING_*` / `STRIPE_PRICE_AI_*`
secrets. **Do not deploy that version on its own** — see the warning earlier in
this file about what "the latest version" actually contains with a preview
open. The next real deploy (step 4) picks the secrets up as part of shipping
the new code, which is the only reason this ordering is safe.

Leave the old `STRIPE_PRICE_STANDARD_*` / `STRIPE_PRICE_PLUS_*` /
`STRIPE_PRICE_PRO_*` secrets in place for now — the code still running in
production is the *old* code until step 4, and it still reads them. Removing
them before then would take checkout down early for no benefit.

**4. Merge and deploy. [owner — deploy button]**

Merge the PR(s) that carry the new tier catalogue and this runbook, then run
**Actions → Deploy to Cloudflare → Run workflow**. Until this deploy actually
ships, the secrets uploaded in step 3 are inert — nothing reads them yet.

**5. Verify.**

```bash
curl -s https://bandup.life/api/billing/health
curl -s https://bandup.life/api/billing/config
```

`health` should say `"ok":true`. `config` should say `"checkout":true` and
list all four plan ids (`tracking-monthly`, `tracking-yearly`, `ai-monthly`,
`ai-yearly`) under `"plans"`. Load `/pricing` and confirm both plans show a
working Subscribe button rather than "subscriptions are not open yet".

**6. Rename the legacy D1 and Postgres rows. [owner — Supabase dashboard for
the Postgres half; anyone with wrangler for the D1 half]**

**Only after step 4 is live — never before.** The *old* code's entitlement
resolver maps any tier it doesn't recognise to `free`, so renaming a row to
`ai` while the old code is still deployed would silently demote that account
to Free until the new deploy landed. Do D1 first, then Postgres:

```bash
npx wrangler d1 execute BANDUP_DB --remote --file=scripts/hand-run-tracking-and-ai-tiers-on-d1.sql
```

That file ends with its own verification `SELECT`, so read its output before
moving on. Then, for Postgres — which is not on the live billing path today
but is kept in step for parity and as a rollback path — paste
`supabase/migrations/0032_tracking_and_ai_tiers.sql` into the Supabase SQL
editor (or run `supabase db push` against a linked project). **Say plainly to
yourself before running it: this changes production the instant it runs,**
the same as any other statement typed directly into that editor. The migration
renames the legacy `standard`/`plus`/`pro` rows to `tracking`/`ai` before it
adds its `CHECK` constraint, which is what lets it run at all against the real
data — a version of it that added the constraint first would abort against the
Pro rows described in step 1.

Little depends on this step happening promptly: the running code aliases the
legacy names to the right tier for entitlements, AI allowances, history and
organisation eligibility, so no learner loses anything between step 4 and step
6. What does still read the stored name until then is display: the owner
console labels the account "Pro plan", and the billing page prints the renewal
date without saying whether it renews. Run step 6 straight after step 5 and
neither is seen.

**7. Clean up. [anyone with wrangler for the secrets; owner for the Stripe
dashboard]**

```bash
npx wrangler versions secret delete STRIPE_PRICE_STANDARD_MONTHLY
npx wrangler versions secret delete STRIPE_PRICE_STANDARD_YEARLY
npx wrangler versions secret delete STRIPE_PRICE_PLUS_MONTHLY
npx wrangler versions secret delete STRIPE_PRICE_PLUS_YEARLY
npx wrangler versions secret delete STRIPE_PRICE_PRO_MONTHLY
npx wrangler versions secret delete STRIPE_PRICE_PRO_YEARLY
```

(`versions secret delete` exists alongside `put`, `bulk`, and `list` — checked
locally with `npx wrangler versions secret --help`. It stages a new undeployed
version without those six secrets, exactly as `versions secret bulk` staged
one with the four new ones in step 3, and takes effect on the next real
deploy — which is fine, because nothing on the new code reads them.)

Finally, in the Stripe dashboard, archive the old **BandUp Standard**,
**BandUp Plus**, and **BandUp Pro** Products (Products → each one → Archive).
`scripts/stripe-setup.mjs` only ever creates and amends the Tracking/AI
catalogue — it does not touch these, so archiving the old ones is a manual,
one-time step.

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
NEXT_PUBLIC_API_BASE=https://bandup.life npm run build:mobile
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
